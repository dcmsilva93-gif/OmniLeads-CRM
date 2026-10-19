import { Router } from 'express';
import { q, pool } from './db.js';
import {
  requireAuth, signupUser, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie
} from './auth.js';

export const api = Router();

/* ---------------- shape mappers (snake_case row -> client shape) ---------------- */
const toLead = r => ({
  id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone,
  value: Number(r.value) || 0, stage: r.stage, source: r.source,
  assignee: r.assignee, notes: r.notes,
  aiScore: r.ai_score == null ? null : Number(r.ai_score),
  aiReason: r.ai_reason || null,
  createdAt: new Date(r.created_at).getTime()
});
const toIntegration = r => ({
  id: r.id, name: r.name, system: r.system, desc: r.descr, method: r.method,
  endpoint: r.endpoint, apiKey: r.api_key, sourceTag: r.source_tag,
  defaultStage: r.default_stage, defaultOwner: r.default_owner, on: r.active,
  webhookToken: r.webhook_token, receivedCount: r.received_count,
  lastReceived: r.last_received ? new Date(r.last_received).getTime() : null,
  lastError: r.last_error || null,
  lastErrorAt: r.last_error_at ? new Date(r.last_error_at).getTime() : null
});
const toSheet = r => ({
  id: r.id, name: r.name, url: r.url, provider: r.provider,
  sourceTag: r.source_tag, defaultStage: r.default_stage,
  defaultOwner: r.default_owner, skipDupes: r.skip_dupes,
  lastSync: r.last_sync ? new Date(r.last_sync).getTime() : null,
  lastError: r.last_error || null
});

/* ---------------- small helpers ---------------- */
const str = (v, max = 500) => String(v == null ? '' : v).slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ===================================================================
   AUTH
   =================================================================== */
api.post('/auth/signup', async (req, res, next) => {
  try {
    const email = str(req.body?.email, 200).trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const company = str(req.body?.company, 80);
    const joinWorkspace = str(req.body?.joinWorkspace, 64).trim() || null;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter a valid email address');
    if (password.length < 8) return bad(res, 'Password must be at least 8 characters');
    if (joinWorkspace && !UUID.test(joinWorkspace)) return bad(res, 'That workspace ID is not valid');

    const user = await signupUser({ email, password, company, joinWorkspace });
    const { token } = await createSession(user.id);
    setSessionCookie(req, res, token);
    res.json({ user: { email: user.email, role: user.role }, workspaceId: user.workspace_id });
  } catch (err) {
    if (err.status) return bad(res, err.message, err.status);
    next(err);
  }
});

api.post('/auth/login', async (req, res, next) => {
  try {
    const email = str(req.body?.email, 200).trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const { rows } = await q(
      'select id, email, password_hash, workspace_id, role from users where lower(email) = $1',
      [email]
    );
    const user = rows[0];
    // Same message and comparable timing whether or not the account exists.
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) return bad(res, 'Email or password is incorrect', 401);

    const { token } = await createSession(user.id);
    setSessionCookie(req, res, token);
    res.json({ user: { email: user.email, role: user.role }, workspaceId: user.workspace_id });
  } catch (err) { next(err); }
});

api.post('/auth/logout', async (req, res, next) => {
  try {
    await destroySession(req.cookies?.omni_session);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ===================================================================
   BOOTSTRAP — one round trip for everything the page needs
   =================================================================== */
api.get('/bootstrap', requireAuth, async (req, res, next) => {
  try {
    const ws = req.user.workspace_id;
    const [wsRow, leads, ints, sheets, members] = await Promise.all([
      q('select id, name, settings from workspaces where id = $1', [ws]),
      q('select * from leads where workspace_id = $1 order by created_at desc limit 5000', [ws]),
      q('select * from integrations where workspace_id = $1 order by created_at', [ws]),
      q('select * from sheet_links where workspace_id = $1 order by created_at', [ws]),
      q('select email, role from users where workspace_id = $1 order by created_at', [ws])
    ]);
    res.json({
      user: { email: req.user.email, role: req.user.role },
      workspaceId: ws,
      settings: wsRow.rows[0]?.settings || {},
      leads: leads.rows.map(toLead),
      integrations: ints.rows.map(toIntegration),
      sheetLinks: sheets.rows.map(toSheet),
      members: members.rows
    });
  } catch (err) { next(err); }
});

/* ===================================================================
   SETTINGS
   =================================================================== */
api.put('/settings', requireAuth, async (req, res, next) => {
  try {
    const settings = req.body?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return bad(res, 'settings must be an object');
    }
    if (JSON.stringify(settings).length > 200_000) return bad(res, 'settings payload too large');
    await q('update workspaces set settings = $1 where id = $2', [settings, req.user.workspace_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ===================================================================
   LEADS
   =================================================================== */
const leadFields = body => ({
  name: str(body.name, 200).trim(),
  company: str(body.company, 200),
  email: str(body.email, 200),
  phone: str(body.phone, 60),
  value: num(body.value),
  stage: str(body.stage, 80) || 'New',
  source: str(body.source, 120),
  assignee: str(body.assignee, 120) || 'Unassigned',
  notes: str(body.notes, 5000)
});

api.post('/leads', requireAuth, async (req, res, next) => {
  try {
    const input = Array.isArray(req.body?.leads) ? req.body.leads : [req.body?.lead];
    const rows = input.filter(Boolean).map(leadFields).filter(l => l.name);
    if (!rows.length) return bad(res, 'at least one lead with a name is required');
    if (rows.length > 2000) return bad(res, 'too many leads in one request (max 2000)');

    // Single multi-row insert: one round trip, one transaction.
    const cols = ['workspace_id','name','company','email','phone','value','stage','source','assignee','notes'];
    const params = [];
    const tuples = rows.map((l, i) => {
      const base = i * cols.length;
      params.push(req.user.workspace_id, l.name, l.company, l.email, l.phone, l.value, l.stage, l.source, l.assignee, l.notes);
      return '(' + cols.map((_, c) => `$${base + c + 1}`).join(',') + ')';
    });
    const { rows: out } = await q(
      `insert into leads (${cols.join(',')}) values ${tuples.join(',')} returning *`,
      params
    );
    res.json({ leads: out.map(toLead) });
  } catch (err) { next(err); }
});

api.patch('/leads/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    const l = leadFields(req.body?.lead || req.body || {});
    if (!l.name) return bad(res, 'name is required');
    const { rows } = await q(
      `update leads set name=$1, company=$2, email=$3, phone=$4, value=$5,
              stage=$6, source=$7, assignee=$8, notes=$9
         where id=$10 and workspace_id=$11
         returning *`,
      [l.name, l.company, l.email, l.phone, l.value, l.stage, l.source, l.assignee, l.notes,
       req.params.id, req.user.workspace_id]
    );
    if (!rows.length) return bad(res, 'lead not found', 404);
    res.json({ lead: toLead(rows[0]) });
  } catch (err) { next(err); }
});

api.delete('/leads', requireAuth, async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(i => UUID.test(i));
    if (!ids.length) return bad(res, 'ids array is required');
    const { rowCount } = await q(
      'delete from leads where workspace_id = $1 and id = any($2::uuid[])',
      [req.user.workspace_id, ids]
    );
    res.json({ deleted: rowCount });
  } catch (err) { next(err); }
});

/* ===================================================================
   INTEGRATIONS
   =================================================================== */
const intFields = b => {
  const system = str(b.system, 120) || 'Custom webhook / API';
  return {
  name: str(b.name, 120).trim(),
  system,
  descr: str(b.desc ?? b.descr, 300),
  method: str(b.method, 40) || 'Webhook',
  endpoint: str(b.endpoint, 500),
  // Meta's credentials live in server environment variables. Refusing to
  // store one here means a crafted request cannot stash a secret in the
  // database where the browser would read it back.
  api_key: system === 'Meta Lead Ads' ? '' : str(b.apiKey, 300),
  source_tag: str(b.sourceTag, 120),
  default_stage: str(b.defaultStage, 80),
  default_owner: str(b.defaultOwner, 120),
  active: b.on !== false
  };
};

api.post('/integrations', requireAuth, async (req, res, next) => {
  try {
    const f = intFields(req.body || {});
    if (!f.name) return bad(res, 'name is required');
    const { rows } = await q(
      `insert into integrations
        (workspace_id,name,system,descr,method,endpoint,api_key,source_tag,default_stage,default_owner,active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [req.user.workspace_id, f.name, f.system, f.descr, f.method, f.endpoint, f.api_key,
       f.source_tag || f.name, f.default_stage, f.default_owner, f.active]
    );
    res.json({ integration: toIntegration(rows[0]) });
  } catch (err) { next(err); }
});

api.patch('/integrations/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    // A toggle sends only { on }; a full edit sends everything.
    if (Object.keys(req.body || {}).length === 1 && typeof req.body.on === 'boolean') {
      const { rows } = await q(
        'update integrations set active=$1 where id=$2 and workspace_id=$3 returning *',
        [req.body.on, req.params.id, req.user.workspace_id]
      );
      if (!rows.length) return bad(res, 'integration not found', 404);
      return res.json({ integration: toIntegration(rows[0]) });
    }
    const f = intFields(req.body || {});
    if (!f.name) return bad(res, 'name is required');
    const { rows } = await q(
      `update integrations set name=$1, system=$2, descr=$3, method=$4, endpoint=$5,
              api_key=$6, source_tag=$7, default_stage=$8, default_owner=$9, active=$10
         where id=$11 and workspace_id=$12 returning *`,
      [f.name, f.system, f.descr, f.method, f.endpoint, f.api_key, f.source_tag || f.name,
       f.default_stage, f.default_owner, f.active, req.params.id, req.user.workspace_id]
    );
    if (!rows.length) return bad(res, 'integration not found', 404);
    res.json({ integration: toIntegration(rows[0]) });
  } catch (err) { next(err); }
});

api.delete('/integrations/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    const { rowCount } = await q(
      'delete from integrations where id=$1 and workspace_id=$2',
      [req.params.id, req.user.workspace_id]
    );
    res.json({ deleted: rowCount });
  } catch (err) { next(err); }
});

/* ===================================================================
   SHEET LINKS
   =================================================================== */
const sheetFields = b => ({
  name: str(b.name, 120).trim(),
  url: str(b.url, 1000).trim(),
  provider: str(b.provider, 80),
  source_tag: str(b.sourceTag, 120),
  default_stage: str(b.defaultStage, 80),
  default_owner: str(b.defaultOwner, 120),
  skip_dupes: b.skipDupes !== false
});

api.post('/sheets', requireAuth, async (req, res, next) => {
  try {
    const f = sheetFields(req.body || {});
    if (!f.name || !f.url) return bad(res, 'name and url are required');
    if (!/^https?:\/\//i.test(f.url)) return bad(res, 'url must start with http:// or https://');
    const { rows } = await q(
      `insert into sheet_links
        (workspace_id,name,url,provider,source_tag,default_stage,default_owner,skip_dupes)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [req.user.workspace_id, f.name, f.url, f.provider, f.source_tag, f.default_stage, f.default_owner, f.skip_dupes]
    );
    res.json({ sheet: toSheet(rows[0]) });
  } catch (err) { next(err); }
});

api.patch('/sheets/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    // Sync status updates arrive on their own.
    if ('lastSync' in (req.body || {}) || 'lastError' in (req.body || {})) {
      const { rows } = await q(
        `update sheet_links
            set last_sync = coalesce($1, last_sync),
                last_error = $2
          where id=$3 and workspace_id=$4 returning *`,
        [req.body.lastSync ? new Date(req.body.lastSync) : null,
         req.body.lastError ? str(req.body.lastError, 500) : null,
         req.params.id, req.user.workspace_id]
      );
      if (!rows.length) return bad(res, 'sheet not found', 404);
      return res.json({ sheet: toSheet(rows[0]) });
    }
    const f = sheetFields(req.body || {});
    if (!f.name || !f.url) return bad(res, 'name and url are required');
    const { rows } = await q(
      `update sheet_links set name=$1, url=$2, provider=$3, source_tag=$4,
              default_stage=$5, default_owner=$6, skip_dupes=$7
         where id=$8 and workspace_id=$9 returning *`,
      [f.name, f.url, f.provider, f.source_tag, f.default_stage, f.default_owner, f.skip_dupes,
       req.params.id, req.user.workspace_id]
    );
    if (!rows.length) return bad(res, 'sheet not found', 404);
    res.json({ sheet: toSheet(rows[0]) });
  } catch (err) { next(err); }
});

api.delete('/sheets/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    const { rowCount } = await q(
      'delete from sheet_links where id=$1 and workspace_id=$2',
      [req.params.id, req.user.workspace_id]
    );
    res.json({ deleted: rowCount });
  } catch (err) { next(err); }
});

/* ===================================================================
   SHEET FETCH PROXY
   The browser cannot fetch most sheet URLs (CORS); the server can.
   =================================================================== */
api.get('/sheets/:id/fetch', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'bad id');
    const { rows } = await q(
      'select url from sheet_links where id=$1 and workspace_id=$2',
      [req.params.id, req.user.workspace_id]
    );
    if (!rows.length) return bad(res, 'sheet not found', 404);

    const target = buildFetchUrl(rows[0].url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let upstream;
    try {
      upstream = await fetch(target, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) return bad(res, `the sheet returned HTTP ${upstream.status}`, 502);

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return bad(res, 'that sheet is larger than 15MB', 413);
    const head = buf.subarray(0, 64).toString('utf8');
    if (/^\s*<(!doctype|html)/i.test(head)) {
      return bad(res, 'the link returned a sign-in page instead of data — make the sheet readable by anyone with the link', 502);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buf);
  } catch (err) {
    if (err.name === 'AbortError') return bad(res, 'the sheet took too long to respond', 504);
    next(err);
  }
});

/** Turn a shareable sheet URL into one that returns raw data. */
export function buildFetchUrl(raw) {
  const u = String(raw || '').trim();
  if (/docs\.google\.com\/spreadsheets/.test(u)) {
    if (/\/pub(\?|$)|output=csv/.test(u)) return u.includes('output=csv') ? u : u + (u.includes('?') ? '&' : '?') + 'output=csv';
    const id = (u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1];
    const gid = (u.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
    if (id) return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;
  }
  if (/sharepoint\.com|onedrive\.live\.com|1drv\.ms|office\.com/.test(u)) {
    return /download=1/.test(u) ? u : u + (u.includes('?') ? '&' : '?') + 'download=1';
  }
  return u;
}

export { pool };
