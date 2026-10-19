import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';

export const hook = Router();

/* ---------------- Meta configuration (server-side only) ----------------
   None of these ever reach the browser. Missing values disable the Meta
   path rather than silently accepting unverified traffic.                */
const META_VERIFY_TOKEN      = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET        = process.env.META_APP_SECRET || '';
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const META_GRAPH_VERSION     = process.env.META_GRAPH_VERSION || 'v26.0';
// Overridable so the test suite can point at a stub instead of Meta.
const META_GRAPH_BASE        = process.env.META_GRAPH_BASE || 'https://graph.facebook.com';

const META_SYSTEM = 'Meta Lead Ads';
const isMetaConnector = i => i.system === META_SYSTEM;

/** Record a failure against a connector so the UI can show it. */
async function recordConnectorError(integrationId, message) {
  const text = String(message || '').slice(0, 500);
  console.error(`[meta] connector ${integrationId}: ${text}`);
  try {
    await q('update integrations set last_error = $1, last_error_at = now() where id = $2',
      [text, integrationId]);
  } catch (err) {
    console.error('[meta] could not record the error:', err.message);
  }
}

async function clearConnectorError(integrationId) {
  try {
    await q('update integrations set last_error = null, last_error_at = null where id = $1 and last_error is not null',
      [integrationId]);
  } catch { /* cosmetic */ }
}

/* ---------------- field extraction ---------------- */
const NAME_KEYS    = ['full_name','fullname','name','contact_name','lead_name','your_name'];
const EMAIL_KEYS   = ['email','email_address','e-mail','mail','work_email'];
const PHONE_KEYS   = ['phone','phone_number','mobile','mobile_number','telephone','tel','whatsapp_number','contact_number'];
const COMPANY_KEYS = ['company','company_name','organisation','organization','business','business_name'];
const VALUE_KEYS   = ['value','budget','deal_value','amount','estimated_budget','deal_size'];
const NOTES_KEYS   = ['notes','comments','message','enquiry','inquiry','remarks','description'];

/** "Rs. 45,000" / "$1,234.56" / "1.234,56" -> a number */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  let s = String(raw ?? '').replace(/[^\d.,\-]/g, '');
  s = s.replace(/^[.,]+/, '').replace(/[.,]+$/, '');
  if (!s) return 0;
  const neg = s.indexOf('-') === 0;
  s = s.replace(/-/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let dec = -1;
  if (lastComma > -1 && lastDot > -1) dec = Math.max(lastComma, lastDot);
  else if (lastComma > -1) dec = (s.split(',').length === 2 && s.length - lastComma - 1 !== 3) ? lastComma : -1;
  else if (lastDot > -1) dec = (s.split('.').length === 2 && s.length - lastDot - 1 !== 3) ? lastDot : -1;
  const intPart = (dec > -1 ? s.slice(0, dec) : s).replace(/[.,]/g, '');
  const frac = (dec > -1 ? s.slice(dec + 1) : '').replace(/[.,]/g, '');
  const n = Number(intPart + (frac ? '.' + frac : '')) || 0;
  return neg ? -n : n;
}

/** Flattens the many shapes ad platforms send into one plain object. */
export function flatten(payload) {
  const out = {};
  const put = (k, v) => {
    const key = String(k ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!key || v == null) return;
    const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (val !== '' && out[key] === undefined) out[key] = val;
  };

  // Meta / TikTok / Typeform style: [{ name: 'email', values: ['x@y.com'] }]
  const arrays = [
    payload?.field_data,
    payload?.entry?.[0]?.changes?.[0]?.value?.field_data,
    payload?.data?.field_data,
    payload?.user_data,
    payload?.form_response?.answers
  ];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const f of arr) put(f?.name ?? f?.field ?? f?.key ?? f?.field_name, f?.values ?? f?.value ?? f?.text ?? f?.answer);
    }
  }

  // Google Ads lead form extension
  if (Array.isArray(payload?.user_column_data)) {
    for (const c of payload.user_column_data) put(c?.column_id ?? c?.column_name, c?.string_value);
  }

  // Plain JSON / form posts, including a couple of levels of nesting
  const scan = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, depth + 1);
      else put(k, v);
    }
  };
  scan(payload, 0);
  return out;
}

/** Exact key match only. */
const pickExact = (f, keys) => {
  for (const k of keys) if (f[k]) return f[k];
  return '';
};

/** Exact match first, then a loose substring match on the field name. */
const pick = (f, keys) => {
  const exact = pickExact(f, keys);
  if (exact) return exact;
  for (const k of keys) {
    const hit = Object.keys(f).find(fk => fk.includes(k));
    if (hit && f[hit]) return f[hit];
  }
  return '';
};

/**
 * Resolving a person's name needs care: a loose match for "name" happily
 * matches "first_name", which would silently drop the surname. So an explicit
 * full-name field wins, then first + last assembled, and only then a loose match.
 */
function resolveName(f) {
  const explicit = pickExact(f, NAME_KEYS);
  if (explicit) return explicit;
  const first = pick(f, ['first_name', 'firstname', 'given_name']);
  const last = pick(f, ['last_name', 'lastname', 'surname', 'family_name']);
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  return pick(f, NAME_KEYS);
}

/* ---------------- Meta subscription handshake ----------------
   Meta sends hub.mode / hub.verify_token / hub.challenge and nothing else,
   so any hub.* parameter means this is the verification call and the strict
   rules apply: subscribe + matching token, or 403. A GET with no hub.*
   parameters is our own liveness check and is left as it was.            */
hook.get('/:token', async (req, res) => {
  // Meta has sent these with dots and, in its reachability probe, with
  // underscores as well. Accept either spelling.
  const param = (...names) => {
    for (const n of names) {
      const v = req.query[n];
      if (typeof v === 'string' && v !== '') return v;
    }
    return undefined;
  };
  const mode = param('hub.mode', 'hub_mode');
  const verifyToken = param('hub.verify_token', 'hub_verify_token');
  const challenge = param('hub.challenge', 'hub_challenge');

  // Before the real challenge, Meta probes the URL with every hub parameter
  // present but blank, and expects the endpoint to answer rather than reject.
  // Treating "present" as "verifying" would fail that probe, so only a
  // non-empty hub.mode counts as a verification attempt.
  if (mode !== undefined || verifyToken !== undefined || challenge !== undefined) {
    if (!META_VERIFY_TOKEN) {
      console.error('[meta] verification attempted but META_VERIFY_TOKEN is not set');
      return res.sendStatus(403);
    }
    const ok = mode === 'subscribe'
      && typeof verifyToken === 'string'
      && safeEqual(verifyToken, META_VERIFY_TOKEN);
    if (!ok) {
      console.error(`[meta] verification refused (mode=${JSON.stringify(mode)}, token ${verifyToken === undefined ? 'absent' : 'mismatched'})`);
      return res.sendStatus(403);
    }
    console.log('[meta] webhook verified');
    // Plain text only — Meta compares the body byte for byte.
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  // A plain GET lets you confirm a URL is live without creating a lead.
  const { rows } = await q('select name, active from integrations where webhook_token = $1', [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'unknown token' });
  res.json({ ok: true, connector: rows[0].name, active: rows[0].active });
});

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Checks X-Hub-Signature-256 against an HMAC-SHA256 of the raw body.
 * Returns a reason string when it fails, or null when it passes.
 */
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return 'META_APP_SECRET is not configured';
  const header = req.get('X-Hub-Signature-256');
  if (!header) return 'X-Hub-Signature-256 header missing';
  const [scheme, provided] = String(header).split('=');
  if (scheme !== 'sha256' || !provided) return 'signature header malformed';
  if (!req.rawBody) return 'raw body unavailable';
  const expected = createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  return safeEqual(provided.toLowerCase(), expected) ? null : 'signature mismatch';
}

/* ---------------- Meta field_data -> a lead ---------------- */
/** Meta's own field names; anything else is a custom question. */
const META_STANDARD = new Set([
  'full_name', 'first_name', 'last_name', 'email', 'phone_number',
  'company_name', 'job_title', 'city', 'state', 'province', 'country',
  'post_code', 'zip_code', 'street_address'
]);

export function mapMetaFieldData(fieldData, meta = {}) {
  const answers = new Map();
  for (const f of Array.isArray(fieldData) ? fieldData : []) {
    const name = String(f?.name ?? '').trim().toLowerCase();
    if (!name) continue;
    const value = Array.isArray(f?.values) ? f.values.filter(v => v != null).join(', ') : String(f?.values ?? '');
    if (value !== '') answers.set(name, value);
  }

  const get = k => answers.get(k) || '';
  const name = get('full_name')
    || [get('first_name'), get('last_name')].filter(Boolean).join(' ').trim();

  // Custom questions are the point of most lead forms, so keep them verbatim.
  const custom = [];
  for (const [k, v] of answers) {
    if (META_STANDARD.has(k)) continue;
    custom.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }

  const provenance = [];
  if (meta.ad_name) provenance.push(`Ad: ${meta.ad_name}`);
  if (meta.campaign_name) provenance.push(`Campaign: ${meta.campaign_name}`);
  if (meta.form_id) provenance.push(`Form: ${meta.form_id}`);
  const location = ['city', 'state', 'province', 'country', 'post_code', 'zip_code', 'street_address']
    .map(k => get(k)).filter(Boolean).join(', ');
  if (location) provenance.push(`Location: ${location}`);
  if (get('job_title')) provenance.push(`Job title: ${get('job_title')}`);

  const notes = [custom.join('\n'), provenance.join(' · ')].filter(Boolean).join('\n');

  return {
    name: name || get('email') || get('phone_number') || 'Unnamed Meta lead',
    company: get('company_name'),
    email: get('email'),
    phone: get('phone_number'),
    notes
  };
}

/* ---------------- Graph API ---------------- */
/**
 * Fetches one lead's details. The access token travels as a query parameter
 * because that is the documented shape for this call — so this URL is never
 * logged, and failures are reported without it.
 */
async function fetchLeadFromGraph(leadgenId) {
  const fields = 'field_data,created_time,ad_id,ad_name,campaign_name,form_id';
  const url = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`
    + `?fields=${fields}&access_token=${encodeURIComponent(META_PAGE_ACCESS_TOKEN)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? 'Graph API timed out after 15s'
      : `could not reach the Graph API: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok || body?.error) {
    const e = body?.error || {};
    // Meta's own codes, translated into something actionable.
    const hint = e.code === 190 ? 'the page access token has expired or been revoked — generate a new META_PAGE_ACCESS_TOKEN'
      : e.code === 102 ? 'the session is invalid — regenerate META_PAGE_ACCESS_TOKEN'
      : e.code === 10 || e.code === 200 ? 'the token lacks permission for this lead (needs leads_retrieval on the page)'
      : e.code === 100 ? 'the lead id or requested fields were rejected'
      : e.code === 4 || e.code === 17 ? 'Meta is rate limiting these requests — it will be retried on the next delivery'
      : `HTTP ${res.status}`;
    throw new Error(`Graph API refused the lead (${e.code ?? res.status}${e.type ? ' ' + e.type : ''}): ${e.message || hint}${e.message ? ` — ${hint}` : ''}`);
  }
  return body;
}

/* ---------------- lead ingest ---------------- */
hook.post('/:token', async (req, res, next) => {
  try {
    const { rows } = await q(
      `select id, workspace_id, name, system, source_tag, default_stage, default_owner, active, received_count
         from integrations where webhook_token = $1`,
      [req.params.token]
    );
    const integration = rows[0];
    if (!integration) return res.status(404).json({ error: 'unknown token' });

    // The Meta connector has its own contract: signed payloads, an immediate
    // 200, and the lead fetched from the Graph API afterwards.
    if (isMetaConnector(integration)) return handleMetaDelivery(req, res, integration);

    if (!integration.active) return res.status(409).json({ error: 'connector is inactive' });

    const payload = req.body ?? {};

    // Meta pings the endpoint with an envelope that carries no lead yet.
    if (payload.object === 'page' && !JSON.stringify(payload).includes('field_data')) {
      return res.json({ ok: true, note: 'subscription ping acknowledged' });
    }

    const f = flatten(payload);
    const name = resolveName(f);
    const email = pick(f, EMAIL_KEYS);
    const phone = pick(f, PHONE_KEYS);

    if (!name && !email && !phone) {
      return res.status(422).json({ error: 'no name, email or phone found in payload', received_keys: Object.keys(f) });
    }

    let stage = integration.default_stage;
    if (!stage) {
      const ws = await q('select settings from workspaces where id = $1', [integration.workspace_id]);
      stage = ws.rows[0]?.settings?.stages?.[0] || 'New';
    }

    // Ad platforms retry; don't create the same lead twice within an hour.
    if (email) {
      const dupe = await q(
        `select id from leads
          where workspace_id = $1 and lower(email) = lower($2)
            and created_at > now() - interval '1 hour' limit 1`,
        [integration.workspace_id, email]
      );
      if (dupe.rows.length) return res.json({ ok: true, deduped: true, lead_id: dupe.rows[0].id });
    }

    const inserted = await q(
      `insert into leads (workspace_id,name,company,email,phone,value,stage,source,assignee,notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        integration.workspace_id,
        (name || email || phone).slice(0, 200),
        pick(f, COMPANY_KEYS).slice(0, 200),
        email.slice(0, 200),
        phone.slice(0, 60),
        parseAmount(pick(f, VALUE_KEYS)),
        stage,
        integration.source_tag || integration.name,
        integration.default_owner || 'Unassigned',
        (pick(f, NOTES_KEYS) || `Received via ${integration.name}`).slice(0, 5000)
      ]
    );

    await q(
      'update integrations set last_received = now(), received_count = received_count + 1 where id = $1',
      [integration.id]
    );

    res.json({ ok: true, lead_id: inserted.rows[0].id, stage, source: integration.source_tag || integration.name });
  } catch (err) { next(err); }
});

/* =====================================================================
   META LEAD ADS
   Meta expects a 200 within a few seconds and retries anything else, so
   the response is sent as soon as the signature checks out and the leads
   are fetched afterwards. A failure after that point is recorded against
   the connector rather than bounced back, because a non-200 would make
   Meta redeliver the same event indefinitely.
   ===================================================================== */
async function handleMetaDelivery(req, res, integration) {
  const badSignature = verifyMetaSignature(req);
  if (badSignature) {
    await recordConnectorError(integration.id, `Rejected a delivery: ${badSignature}`);
    // 'not configured' is our fault, not the caller's.
    const status = badSignature.includes('not configured') ? 503 : 401;
    return res.status(status).json({ error: badSignature });
  }

  const payload = req.body ?? {};

  // Acknowledge first. Everything below runs after the response.
  res.sendStatus(200);

  try {
    const events = [];
    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        if (change?.field !== 'leadgen') continue;
        const v = change.value || {};
        if (!v.leadgen_id) continue;
        events.push({
          leadgen_id: String(v.leadgen_id),
          form_id: v.form_id ? String(v.form_id) : '',
          ad_id: v.ad_id ? String(v.ad_id) : '',
          page_id: v.page_id ? String(v.page_id) : '',
          created_time: v.created_time ?? null
        });
      }
    }

    if (!events.length) {
      // Subscription pings and non-leadgen fields land here; nothing to do.
      console.log('[meta] delivery carried no leadgen events');
      return;
    }

    if (!META_PAGE_ACCESS_TOKEN) {
      await recordConnectorError(integration.id,
        `Received ${events.length} lead(s) but META_PAGE_ACCESS_TOKEN is not set, so their details could not be fetched`);
      return;
    }

    let created = 0, duplicates = 0, failed = 0;

    for (const ev of events) {
      try {
        const detail = await fetchLeadFromGraph(ev.leadgen_id);
        const mapped = mapMetaFieldData(detail.field_data, {
          ad_name: detail.ad_name,
          campaign_name: detail.campaign_name,
          form_id: detail.form_id || ev.form_id
        });

        const stage = integration.default_stage || 'New';
        const source = integration.source_tag || 'Meta Ads';
        const createdAt = detail.created_time || ev.created_time || null;

        // ON CONFLICT makes a redelivery a no-op instead of a second lead.
        const ins = await q(
          `insert into leads
             (workspace_id, name, company, email, phone, value, stage, source, assignee, notes, leadgen_id, created_at)
           values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))
           on conflict (workspace_id, leadgen_id) where leadgen_id is not null
           do nothing
           returning id`,
          [
            integration.workspace_id,
            mapped.name.slice(0, 200),
            mapped.company.slice(0, 200),
            mapped.email.slice(0, 200),
            mapped.phone.slice(0, 60),
            stage,
            source,
            integration.default_owner || 'Unassigned',
            mapped.notes.slice(0, 5000),
            ev.leadgen_id,
            createdAt
          ]
        );

        if (ins.rows.length) {
          created++;
          console.log(`[meta] lead ${ev.leadgen_id} saved as ${ins.rows[0].id} (${source} / ${stage})`);
        } else {
          duplicates++;
          console.log(`[meta] lead ${ev.leadgen_id} already present — ignored`);
        }
      } catch (err) {
        failed++;
        await recordConnectorError(integration.id, `Lead ${ev.leadgen_id}: ${err.message}`);
      }
    }

    // Only count what actually became a lead, and only call the connector
    // healthy when nothing failed in this delivery.
    if (created) {
      await q(
        `update integrations
            set last_received = now(),
                received_count = received_count + $2,
                active = true
          where id = $1`,
        [integration.id, created]
      );
    }
    if (!failed && (created || duplicates)) await clearConnectorError(integration.id);

    console.log(`[meta] delivery done: ${created} saved, ${duplicates} duplicate(s), ${failed} failed`);
  } catch (err) {
    await recordConnectorError(integration.id, `Delivery processing failed: ${err.message}`);
  }
}
