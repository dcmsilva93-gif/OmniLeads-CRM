// Meta Lead Ads webhook tests. Runs a stub Graph API on 3470 so the whole
// path — signature, fetch, mapping, dedupe, error reporting — is exercised
// without touching Meta.
//
//   node meta-test.mjs
// expects the app on BASE with:
//   META_VERIFY_TOKEN=test-verify-token
//   META_APP_SECRET=test-app-secret
//   META_PAGE_ACCESS_TOKEN=test-page-token
//   META_GRAPH_BASE=http://127.0.0.1:3470

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:3456';
const VERIFY_TOKEN = 'test-verify-token';
const APP_SECRET = 'test-app-secret';
const GRAPH_PORT = 3470;

let fails = 0, passes = 0;
const ok = (n, c, x) => { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const section = t => console.log('\n' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- stub Graph API ---------------- */
const graphHits = [];
const graph = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const id = url.pathname.split('/').pop();
  graphHits.push({ path: url.pathname, token: url.searchParams.get('access_token'), fields: url.searchParams.get('fields') });
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (id === 'LEAD_EXPIRED') {
    return json(400, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } });
  }
  if (id === 'LEAD_NOPERM') {
    return json(403, { error: { message: 'Insufficient permission to access leads', type: 'OAuthException', code: 10 } });
  }
  if (id === 'LEAD_FIRSTLAST') {
    return json(200, {
      id, created_time: '2026-10-19T06:00:00+0000', ad_id: 'AD9', ad_name: 'Winter Promo',
      campaign_name: 'Q4 Leads', form_id: 'FORM7',
      field_data: [
        { name: 'first_name', values: ['Kamal'] },
        { name: 'last_name', values: ['Jayasuriya'] },
        { name: 'email', values: ['kamal@j.lk'] }
      ]
    });
  }
  if (id === 'LEAD_CUSTOM') {
    return json(200, {
      id, created_time: '2026-10-19T06:05:00+0000', ad_id: 'AD3', ad_name: 'Consult Ad',
      campaign_name: 'Consultations', form_id: 'FORM2',
      field_data: [
        { name: 'full_name', values: ['Nimal Perera'] },
        { name: 'email', values: ['nimal@tea.lk'] },
        { name: 'phone_number', values: ['+94771234567'] },
        { name: 'company_name', values: ['Ceylon Tea'] },
        { name: 'job_title', values: ['Marketing Lead'] },
        { name: 'city', values: ['Colombo'] },
        { name: 'what_is_your_monthly_budget', values: ['Rs. 250,000'] },
        { name: 'when_do_you_want_to_start', values: ['Next month'] },
        { name: 'preferred_channels', values: ['Facebook', 'Instagram'] }
      ]
    });
  }
  // default happy lead
  return json(200, {
    id, created_time: '2026-10-19T06:10:00+0000', ad_id: 'AD1', ad_name: 'Default Ad',
    campaign_name: 'Always On', form_id: 'FORM1',
    field_data: [
      { name: 'full_name', values: ['Ayesha Khan'] },
      { name: 'email', values: ['ayesha@khan.lk'] }
    ]
  });
});
await new Promise(r => graph.listen(GRAPH_PORT, '127.0.0.1', r));

/* ---------------- helpers ---------------- */
function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const setC = res.headers.get('set-cookie');
      if (setC) { const m = setC.match(/omni_session=([^;]*)/); if (m) cookie = m[1] ? `omni_session=${m[1]}` : ''; }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) { try { data = await res.json(); } catch {} } else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    }
  };
}

const sign = raw => 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex');

async function postMeta(token, payload, { signature, omitSignature } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (!omitSignature) headers['X-Hub-Signature-256'] = signature ?? sign(raw);
  const res = await fetch(`${BASE}/hook/${token}`, { method: 'POST', headers, body: raw });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const leadgenEvent = (leadgenId, extra = {}) => ({
  object: 'page',
  entry: [{
    id: 'PAGE1',
    time: 1792000000,
    changes: [{
      field: 'leadgen',
      value: { leadgen_id: leadgenId, form_id: 'FORM1', ad_id: 'AD1', page_id: 'PAGE1', created_time: 1792000000, ...extra }
    }]
  }]
});

/* ================================================================ */
const A = jar();
const stamp = Date.now();
let metaToken, metaId, genericToken;

section('0. Set up a workspace and find the Meta connector');
{
  const r = await A.call('POST', '/api/auth/signup', { email: `meta${stamp}@acme.lk`, password: 'a good password', company: 'Meta Test Co' });
  ok('signup', r.status === 200, r.data);
  const b = await A.call('GET', '/api/bootstrap');
  const meta = b.data.integrations.find(i => i.system === 'Meta Lead Ads');
  ok('Meta connector exists out of the box', !!meta, b.data.integrations.map(i => i.system));
  metaToken = meta.webhookToken;
  metaId = meta.id;
  ok('it starts inactive', meta.on === false);
  const generic = b.data.integrations.find(i => i.system === 'Google Ads');
  genericToken = generic.webhookToken;
}

section('1. GET verification');
{
  let r = await fetch(`${BASE}/hook/${metaToken}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE123`);
  const body = await r.text();
  ok('subscribe + correct token → 200', r.status === 200, r.status);
  ok('body is the bare challenge', body === 'CHALLENGE123', JSON.stringify(body));
  ok('content type is plain text', (r.headers.get('content-type') || '').includes('text/plain'), r.headers.get('content-type'));

  r = await fetch(`${BASE}/hook/${metaToken}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`);
  ok('wrong verify token → 403', r.status === 403, r.status);
  ok('no challenge echoed on failure', !(await r.text()).includes('X'));

  r = await fetch(`${BASE}/hook/${metaToken}?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=X`);
  ok('mode other than subscribe → 403', r.status === 403, r.status);

  r = await fetch(`${BASE}/hook/${metaToken}?hub.mode=subscribe&hub.challenge=X`);
  ok('missing verify token → 403', r.status === 403, r.status);

  // Regression: the plain liveness GET other connectors use must still work.
  r = await fetch(`${BASE}/hook/${genericToken}`);
  const j = await r.json();
  ok('bare GET still returns the liveness check', r.status === 200 && j.ok === true, j);

  // The exact probe Meta sends before the real challenge: every parameter
  // present but blank, in both spellings. It must not be treated as a failed
  // verification, or Meta reports the callback URL as unvalidatable.
  const probe = 'hub.mode=&hub.challenge=&hub.verify_token=&hub_mode=&hub_challenge=&hub_verify_token=';
  r = await fetch(`${BASE}/hook/${metaToken}?${probe}`);
  ok('Meta reachability probe answers 200, not 403', r.status === 200, r.status);

  // Underscore spelling of a genuine verification still works.
  r = await fetch(`${BASE}/hook/${metaToken}?hub_mode=subscribe&hub_verify_token=${VERIFY_TOKEN}&hub_challenge=UNDERSCORE1`);
  const underscoreBody = await r.text();
  ok('underscore spelling verifies too', r.status === 200 && underscoreBody === 'UNDERSCORE1', { status: r.status, body: underscoreBody });

  // A blank verify token must never be accepted as a match.
  r = await fetch(`${BASE}/hook/${metaToken}?hub.mode=subscribe&hub.verify_token=&hub.challenge=X`);
  ok('blank verify token with real mode → 403', r.status === 403, r.status);
}

section('2. POST signature verification');
{
  let r = await postMeta(metaToken, leadgenEvent('LEAD_A'), { omitSignature: true });
  ok('missing signature → 401', r.status === 401, { status: r.status, data: r.data });

  r = await postMeta(metaToken, leadgenEvent('LEAD_A'), { signature: 'sha256=' + '0'.repeat(64) });
  ok('wrong signature → 401', r.status === 401, r.status);

  r = await postMeta(metaToken, leadgenEvent('LEAD_A'), { signature: 'garbage' });
  ok('malformed signature header → 401', r.status === 401, r.status);

  // A signature over different bytes than were sent must not pass.
  const raw = JSON.stringify(leadgenEvent('LEAD_A'));
  r = await fetch(`${BASE}/hook/${metaToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw + ' ') },
    body: raw
  });
  ok('signature over tampered bytes → 401', r.status === 401, r.status);

  const b = await A.call('GET', '/api/bootstrap');
  const meta = b.data.integrations.find(i => i.id === metaId);
  ok('rejections are recorded on the connector', !!meta.lastError, meta.lastError);
  ok('the reason is specific', /signature|header/i.test(meta.lastError || ''), meta.lastError);
  ok('no leads were created', b.data.leads.length === 0, b.data.leads.length);
}

section('3. A real delivery');
{
  const before = graphHits.length;
  const r = await postMeta(metaToken, leadgenEvent('LEAD_CUSTOM'));
  ok('valid signature → 200', r.status === 200, { status: r.status, data: r.data });
  await sleep(1200);   // processing happens after the response

  ok('the Graph API was called', graphHits.length === before + 1, graphHits.length - before);
  const hit = graphHits[graphHits.length - 1];
  ok('called the right lead id', hit.path.endsWith('/LEAD_CUSTOM'), hit.path);
  ok('used the configured graph version', hit.path.includes('/v26.0/'), hit.path);
  ok('sent the page access token', hit.token === 'test-page-token', hit.token);
  ok('asked for the specified fields', hit.fields === 'field_data,created_time,ad_id,ad_name,campaign_name,form_id', hit.fields);

  const b = await A.call('GET', '/api/bootstrap');
  const lead = b.data.leads.find(l => l.email === 'nimal@tea.lk');
  ok('lead saved', !!lead, b.data.leads.map(l => l.email));
  ok('full_name mapped', lead?.name === 'Nimal Perera', lead?.name);
  ok('phone_number mapped', lead?.phone === '+94771234567', lead?.phone);
  ok('company_name mapped', lead?.company === 'Ceylon Tea', lead?.company);
  ok('source is Meta Ads', lead?.source === 'Meta Ads', lead?.source);
  ok('stage is New', lead?.stage === 'New', lead?.stage);
  ok('custom question kept in notes', /monthly budget: Rs\. 250,000/i.test(lead?.notes || ''), lead?.notes);
  ok('second custom question kept', /when do you want to start: Next month/i.test(lead?.notes || ''));
  ok('multi-value answer joined', /Facebook, Instagram/.test(lead?.notes || ''));
  ok('ad and campaign recorded', /Ad: Consult Ad/.test(lead?.notes || '') && /Campaign: Consultations/.test(lead?.notes || ''), lead?.notes);
  ok('job title and city recorded', /Marketing Lead/.test(lead?.notes || '') && /Colombo/.test(lead?.notes || ''));
  ok('created_time from Meta is used', new Date(lead.createdAt).toISOString().startsWith('2026-10-19T06:05'), new Date(lead.createdAt).toISOString());

  const meta = b.data.integrations.find(i => i.id === metaId);
  ok('connector marked active', meta.on === true, meta.on);
  ok('leads attributed counted', meta.receivedCount === 1, meta.receivedCount);
  ok('last_received set', !!meta.lastReceived);
  ok('previous error cleared after success', !meta.lastError, meta.lastError);
}

section('4. Redelivery must not duplicate');
{
  const before = (await A.call('GET', '/api/bootstrap')).data.leads.length;
  let r = await postMeta(metaToken, leadgenEvent('LEAD_CUSTOM'));
  ok('redelivery still acknowledged with 200', r.status === 200, r.status);
  await sleep(1000);
  const after = await A.call('GET', '/api/bootstrap');
  ok('no second lead created', after.data.leads.length === before, { before, after: after.data.leads.length });
  const meta = after.data.integrations.find(i => i.id === metaId);
  ok('count not inflated by the duplicate', meta.receivedCount === 1, meta.receivedCount);

  // Three at once, all the same id.
  await Promise.all([1, 2, 3].map(() => postMeta(metaToken, leadgenEvent('LEAD_CUSTOM'))));
  await sleep(1500);
  const after2 = await A.call('GET', '/api/bootstrap');
  ok('concurrent redeliveries stay deduped', after2.data.leads.length === before, after2.data.leads.length);
}

section('5. first_name + last_name');
{
  const r = await postMeta(metaToken, leadgenEvent('LEAD_FIRSTLAST'));
  ok('accepted', r.status === 200);
  await sleep(1200);
  const b = await A.call('GET', '/api/bootstrap');
  const lead = b.data.leads.find(l => l.email === 'kamal@j.lk');
  ok('assembled into a full name', lead?.name === 'Kamal Jayasuriya', lead?.name);
}

section('6. Several leads in one delivery');
{
  const payload = {
    object: 'page',
    entry: [{
      id: 'PAGE1', time: 1,
      changes: [
        { field: 'leadgen', value: { leadgen_id: 'LEAD_M1', form_id: 'F', page_id: 'P' } },
        { field: 'leadgen', value: { leadgen_id: 'LEAD_M2', form_id: 'F', page_id: 'P' } },
        { field: 'messages', value: { something: 'else' } }
      ]
    }]
  };
  const before = (await A.call('GET', '/api/bootstrap')).data.leads.length;
  const r = await postMeta(metaToken, payload);
  ok('accepted', r.status === 200);
  await sleep(1800);
  const after = await A.call('GET', '/api/bootstrap');
  ok('both leadgen changes became leads', after.data.leads.length === before + 2, after.data.leads.length - before);
  ok('the non-leadgen change was ignored', !after.data.leads.some(l => /something/.test(l.notes || '')));
}

section('7. Graph API errors surface, without creating a lead');
{
  const before = (await A.call('GET', '/api/bootstrap')).data.leads.length;
  let r = await postMeta(metaToken, leadgenEvent('LEAD_EXPIRED'));
  ok('still acknowledged with 200 so Meta stops retrying', r.status === 200, r.status);
  await sleep(1200);
  let b = await A.call('GET', '/api/bootstrap');
  ok('no lead created', b.data.leads.length === before, b.data.leads.length - before);
  let meta = b.data.integrations.find(i => i.id === metaId);
  ok('error shown on the connector', !!meta.lastError, meta.lastError);
  ok('explains the expired token', /expired|190/i.test(meta.lastError), meta.lastError);
  ok('names the variable to replace', /META_PAGE_ACCESS_TOKEN/.test(meta.lastError), meta.lastError);
  ok('error has a timestamp', !!meta.lastErrorAt);
  ok('the token value itself is not in the message', !meta.lastError.includes('test-page-token'), meta.lastError);

  r = await postMeta(metaToken, leadgenEvent('LEAD_NOPERM'));
  await sleep(1200);
  b = await A.call('GET', '/api/bootstrap');
  meta = b.data.integrations.find(i => i.id === metaId);
  ok('permission error explained', /permission|leads_retrieval/i.test(meta.lastError), meta.lastError);
}

section('8. Subscription ping with no leadgen event');
{
  const before = (await A.call('GET', '/api/bootstrap')).data.leads.length;
  const r = await postMeta(metaToken, { object: 'page', entry: [{ id: 'PAGE1', time: 1 }] });
  ok('acknowledged with 200', r.status === 200, r.status);
  await sleep(600);
  const after = await A.call('GET', '/api/bootstrap');
  ok('nothing created', after.data.leads.length === before);
}

section('9. The Meta connector cannot hold a browser-side key');
{
  const r = await A.call('PATCH', '/api/integrations/' + metaId, {
    name: 'Meta (Facebook & Instagram)', system: 'Meta Lead Ads', method: 'Webhook',
    sourceTag: 'Meta Ads', defaultStage: 'New', defaultOwner: '', on: true,
    apiKey: 'super-secret-should-not-persist'
  });
  ok('edit accepted', r.status === 200, r.data);
  ok('the key was discarded', r.data.integration.apiKey === '', r.data.integration.apiKey);
  const b = await A.call('GET', '/api/bootstrap');
  const meta = b.data.integrations.find(i => i.id === metaId);
  ok('and is absent on reload', !meta.apiKey, meta.apiKey);
}

section('10. Unknown token');
{
  const r = await postMeta('deadbeefdeadbeef', leadgenEvent('LEAD_A'));
  ok('unknown connector → 404', r.status === 404, r.status);
}

/* ================================================================ */
graph.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
