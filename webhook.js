import { Router } from 'express';
import { q } from './db.js';

export const hook = Router();

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';

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

/* ---------------- Meta subscription handshake ---------------- */
hook.get('/:token', async (req, res) => {
  if (req.query['hub.mode']) {
    const ok = META_VERIFY_TOKEN && req.query['hub.verify_token'] === META_VERIFY_TOKEN;
    return ok ? res.status(200).send(String(req.query['hub.challenge'] ?? ''))
              : res.status(403).json({ error: 'verify token mismatch' });
  }
  // A plain GET lets you confirm a URL is live without creating a lead.
  const { rows } = await q('select name, active from integrations where webhook_token = $1', [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'unknown token' });
  res.json({ ok: true, connector: rows[0].name, active: rows[0].active });
});

/* ---------------- lead ingest ---------------- */
hook.post('/:token', async (req, res, next) => {
  try {
    const { rows } = await q(
      `select id, workspace_id, name, source_tag, default_stage, default_owner, active, received_count
         from integrations where webhook_token = $1`,
      [req.params.token]
    );
    const integration = rows[0];
    if (!integration) return res.status(404).json({ error: 'unknown token' });
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
