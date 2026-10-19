// End-to-end test against a running server. Not shipped to production use;
// run with: node e2e-test.mjs  (expects BASE to be serving)
const BASE = process.env.BASE || 'http://127.0.0.1:3456';

let fails = 0, passes = 0;
const ok = (name, cond, extra) => {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n' + t);

/** Minimal cookie jar so we can hold several sessions at once. */
function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body, raw) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
          ...(raw?.headers || {}),
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: raw?.body ?? (body ? JSON.stringify(body) : undefined),
        redirect: 'manual'
      });
      const setC = res.headers.get('set-cookie');
      if (setC) {
        const m = setC.match(/omni_session=([^;]*)/);
        if (m) cookie = m[1] ? `omni_session=${m[1]}` : '';
      }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) { try { data = await res.json(); } catch {} }
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    }
  };
}

const A = jar();           // first workspace owner
const B = jar();           // unrelated second workspace
const C = jar();           // teammate invited into A's workspace
const stamp = Date.now();
const emailA = `owner${stamp}@acme.lk`;
const emailB = `other${stamp}@rival.lk`;
const emailC = `mate${stamp}@acme.lk`;

/* ================================================================ */
section('1. Unauthenticated access is refused');
for (const [m, p] of [['GET','/api/bootstrap'], ['POST','/api/leads'], ['PUT','/api/settings'], ['GET','/api/events']]) {
  const r = await jar().call(m, p, m === 'POST' ? { leads: [] } : undefined);
  ok(`${m} ${p} → 401`, r.status === 401, r.status);
}
{
  const r = await jar().call('GET', '/');
  ok('the page itself is public (login gate is client-side)', r.status === 200 && String(r.data).includes('OmniLeads'), r.status);
}

/* ================================================================ */
section('2. Signup validation');
{
  let r = await jar().call('POST', '/api/auth/signup', { email: 'not-an-email', password: 'longenough1' });
  ok('rejects a malformed email', r.status === 400, r.data);
  r = await jar().call('POST', '/api/auth/signup', { email: `x${stamp}@y.lk`, password: 'short' });
  ok('rejects a password under 8 chars', r.status === 400, r.data);
  r = await jar().call('POST', '/api/auth/signup', { email: `x${stamp}@y.lk`, password: 'longenough1', joinWorkspace: 'not-a-uuid' });
  ok('rejects a malformed workspace id', r.status === 400, r.data);
  r = await jar().call('POST', '/api/auth/signup', {
    email: `x${stamp}@y.lk`, password: 'longenough1',
    joinWorkspace: '11111111-1111-1111-1111-111111111111'
  });
  ok('rejects an unknown workspace id', r.status === 404, r.data);
}

/* ================================================================ */
section('3. Signup provisions a workspace');
let wsA;
{
  const r = await A.call('POST', '/api/auth/signup', { email: emailA, password: 'correct horse 1', company: 'Acme Lanka' });
  ok('signup succeeds', r.status === 200, r.data);
  ok('session cookie issued', !!A.cookie);
  wsA = r.data?.workspaceId;
  ok('workspace id returned', !!wsA);
  ok('first user is owner', r.data?.user?.role === 'owner', r.data?.user);

  const b = await A.call('GET', '/api/bootstrap');
  ok('bootstrap works', b.status === 200, b.status);
  ok('company name became the CRM name', b.data?.settings?.crmName === 'Acme Lanka', b.data?.settings?.crmName);
  ok('default stages present', Array.isArray(b.data?.settings?.stages) && b.data.settings.stages.length === 6, b.data?.settings?.stages);
  ok('three starter connectors', b.data?.integrations?.length === 3, b.data?.integrations?.length);
  ok('starter connectors are inactive', b.data?.integrations?.every(i => i.on === false));
  ok('every connector has a webhook token', b.data?.integrations?.every(i => !!i.webhookToken));
  ok('no leads yet', b.data?.leads?.length === 0);
  ok('member roster has one', b.data?.members?.length === 1, b.data?.members);
}

{
  const r = await jar().call('POST', '/api/auth/signup', { email: emailA, password: 'another one here' });
  ok('duplicate email refused', r.status === 409, r.data);
}

/* ================================================================ */
section('4. Login');
{
  const fresh = jar();
  let r = await fresh.call('POST', '/api/auth/login', { email: emailA, password: 'wrong password!' });
  ok('wrong password → 401', r.status === 401, r.status);
  ok('error message does not reveal whether the account exists', /incorrect/i.test(r.data?.error || ''), r.data);
  r = await fresh.call('POST', '/api/auth/login', { email: emailA.toUpperCase(), password: 'correct horse 1' });
  ok('login is case-insensitive on email', r.status === 200, r.data);
  r = await fresh.call('POST', '/api/auth/login', { email: `ghost${stamp}@nowhere.lk`, password: 'whatever12' });
  ok('unknown account → 401, same message', r.status === 401 && /incorrect/i.test(r.data?.error || ''), r.data);
}

/* ================================================================ */
section('5. Lead CRUD');
let leadId;
{
  let r = await A.call('POST', '/api/leads', { leads: [
    { name: 'Nimal Perera', company: 'Ceylon Tea', email: 'nimal@tea.lk', value: 45000, stage: 'Qualified', source: 'Google Ads', assignee: 'owner', notes: 'met at expo' },
    { name: 'Asha Silva', company: 'Lanka Soft', email: 'asha@lanka.lk', value: 12000, stage: 'New', source: 'Meta Ads' }
  ]});
  ok('bulk insert', r.status === 200 && r.data.leads.length === 2, r.data);
  leadId = r.data.leads.find(l => l.name === 'Nimal Perera')?.id;
  ok('server assigned real uuids', /^[0-9a-f-]{36}$/.test(leadId || ''), leadId);
  ok('value is a number, not a string', typeof r.data.leads[0].value === 'number', typeof r.data.leads[0].value);

  r = await A.call('POST', '/api/leads', { leads: [{ name: '', company: 'No Name Co' }] });
  ok('rejects a nameless lead', r.status === 400, r.data);

  r = await A.call('PATCH', '/api/leads/' + leadId, { lead: { name: 'Nimal Perera', company: 'Ceylon Tea', value: 50000, stage: 'Won', source: 'Google Ads', assignee: 'owner', notes: 'closed' } });
  ok('update works', r.status === 200 && r.data.lead.stage === 'Won', r.data);
  ok('updated value persisted', r.data.lead.value === 50000, r.data.lead.value);

  r = await A.call('PATCH', '/api/leads/00000000-0000-0000-0000-000000000000', { lead: { name: 'Ghost' } });
  ok('updating a nonexistent lead → 404', r.status === 404, r.status);

  r = await A.call('PATCH', '/api/leads/not-a-uuid', { lead: { name: 'X' } });
  ok('malformed id → 400', r.status === 400, r.status);
}

/* ================================================================ */
section('6. Workspace isolation — the heart of multi-tenancy');
let wsB;
{
  const r = await B.call('POST', '/api/auth/signup', { email: emailB, password: 'different pass 2', company: 'Rival Co' });
  wsB = r.data?.workspaceId;
  ok('second workspace created', !!wsB && wsB !== wsA);

  const b = await B.call('GET', '/api/bootstrap');
  ok('B sees none of A\'s leads', b.data?.leads?.length === 0, b.data?.leads?.length);
  ok('B sees its own CRM name', b.data?.settings?.crmName === 'Rival Co', b.data?.settings?.crmName);
  ok('B sees only itself as a member', b.data?.members?.length === 1);

  let r2 = await B.call('PATCH', '/api/leads/' + leadId, { lead: { name: 'Hijacked' } });
  ok('B cannot update A\'s lead', r2.status === 404, r2.status);

  r2 = await B.call('DELETE', '/api/leads', { ids: [leadId] });
  ok('B cannot delete A\'s lead', r2.data?.deleted === 0, r2.data);

  const check = await A.call('GET', '/api/bootstrap');
  ok('A\'s lead survived both attempts', check.data.leads.some(l => l.id === leadId && l.name === 'Nimal Perera'));

  const intB = await B.call('GET', '/api/bootstrap');
  const aInt = check.data.integrations[0].id;
  r2 = await B.call('PATCH', '/api/integrations/' + aInt, { on: true });
  ok('B cannot touch A\'s connector', r2.status === 404, r2.status);
  r2 = await B.call('DELETE', '/api/integrations/' + aInt);
  ok('B cannot delete A\'s connector', r2.data?.deleted === 0, r2.data);
}

/* ================================================================ */
section('7. Teammate joins by workspace id');
{
  const r = await C.call('POST', '/api/auth/signup', { email: emailC, password: 'third pass here', joinWorkspace: wsA });
  ok('join succeeds', r.status === 200, r.data);
  ok('joined A\'s workspace', r.data?.workspaceId === wsA, r.data?.workspaceId);
  ok('joiner is a member, not owner', r.data?.user?.role === 'member', r.data?.user);

  const b = await C.call('GET', '/api/bootstrap');
  ok('teammate sees A\'s leads', b.data?.leads?.some(l => l.id === leadId));
  ok('teammate sees shared settings', b.data?.settings?.crmName === 'Acme Lanka');
  ok('roster now shows two', b.data?.members?.length === 2, b.data?.members?.length);
}

/* ================================================================ */
section('8. Settings');
{
  let r = await A.call('PUT', '/api/settings', { settings: { crmName: 'Acme Marketing', currency: 'LKR', stages: ['New','Won','Lost'], salesReps: ['Dinesh'] } });
  ok('settings saved', r.status === 200, r.data);
  const b = await A.call('GET', '/api/bootstrap');
  ok('settings read back', b.data.settings.currency === 'LKR' && b.data.settings.crmName === 'Acme Marketing', b.data.settings);
  const cSees = await C.call('GET', '/api/bootstrap');
  ok('teammate sees the change', cSees.data.settings.currency === 'LKR');
  r = await A.call('PUT', '/api/settings', { settings: 'not an object' });
  ok('rejects non-object settings', r.status === 400, r.data);
}

/* ================================================================ */
section('9. Webhook lead ingest');
let token;
{
  // Activate a connector and grab its token
  const b = await A.call('GET', '/api/bootstrap');
  const google = b.data.integrations.find(i => i.system === 'Google Ads');
  token = google.webhookToken;

  let r = await jar().call('POST', '/hook/' + token, { full_name: 'Should Fail', email: 'x@y.lk' });
  ok('inactive connector refuses with 409', r.status === 409, r.data);

  await A.call('PATCH', '/api/integrations/' + google.id, { on: true });

  r = await jar().call('POST', '/hook/deadbeefdeadbeef', { full_name: 'Nobody' });
  ok('unknown token → 404', r.status === 404, r.status);

  r = await jar().call('GET', '/hook/' + token);
  ok('GET confirms the connector is live', r.status === 200 && r.data.active === true, r.data);

  // Google Ads lead form shape
  r = await jar().call('POST', '/hook/' + token, {
    user_column_data: [
      { column_id: 'FULL_NAME', string_value: 'Ravi Fernando' },
      { column_id: 'EMAIL', string_value: 'ravi@biz.lk' },
      { column_id: 'PHONE_NUMBER', string_value: '+94771234567' },
      { column_id: 'COMPANY_NAME', string_value: 'Biz Lanka' }
    ]
  });
  ok('Google Ads payload accepted', r.status === 200 && r.data.ok, r.data);
  ok('routed to the connector\'s stage', r.data.stage === 'New', r.data.stage);
  ok('tagged with the connector\'s source', r.data.source === 'Google Ads', r.data.source);

  // Meta field_data shape, with a money string
  r = await jar().call('POST', '/hook/' + token, {
    field_data: [
      { name: 'full_name', values: ['Ayesha Khan'] },
      { name: 'email', values: ['ayesha@khan.lk'] },
      { name: 'budget', values: ['Rs. 85,000'] },
      { name: 'message', values: ['Need help with paid social'] }
    ]
  });
  ok('Meta payload accepted', r.status === 200 && r.data.ok, r.data);

  // Meta subscription ping carries no lead
  r = await jar().call('POST', '/hook/' + token, { object: 'page', entry: [{ id: '1', time: 1 }] });
  ok('Meta subscription ping acknowledged without creating a lead', r.status === 200 && r.data.note, r.data);

  // form-encoded website post
  r = await jar().call('POST', '/hook/' + token, null, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=Website%20Visitor&email=visitor%40site.lk&enquiry=Pricing%20please'
  });
  ok('form-encoded payload accepted', r.status === 200 && r.data.ok, r.data);

  // first/last name assembly
  r = await jar().call('POST', '/hook/' + token, { first_name: 'Kamal', last_name: 'Jayasuriya', email: 'kamal@j.lk' });
  ok('first + last name combined', r.status === 200, r.data);

  // nothing usable
  r = await jar().call('POST', '/hook/' + token, { favourite_colour: 'blue' });
  ok('payload with no contact details → 422', r.status === 422, r.data);

  // dedupe on repeat delivery
  r = await jar().call('POST', '/hook/' + token, { full_name: 'Ravi Fernando', email: 'ravi@biz.lk' });
  ok('repeat delivery of same email is deduped', r.data?.deduped === true, r.data);

  const after = await A.call('GET', '/api/bootstrap');
  const ravi = after.data.leads.find(l => l.email === 'ravi@biz.lk');
  const ayesha = after.data.leads.find(l => l.email === 'ayesha@khan.lk');
  const kamal = after.data.leads.find(l => l.email === 'kamal@j.lk');
  ok('Google lead landed in the pipeline', !!ravi);
  ok('phone captured', ravi?.phone === '+94771234567', ravi?.phone);
  ok('company captured', ravi?.company === 'Biz Lanka', ravi?.company);
  ok('"Rs. 85,000" parsed to 85000', ayesha?.value === 85000, ayesha?.value);
  ok('notes captured from message field', /paid social/.test(ayesha?.notes || ''), ayesha?.notes);
  ok('name assembled as "Kamal Jayasuriya"', kamal?.name === 'Kamal Jayasuriya', kamal?.name);

  const gInt = after.data.integrations.find(i => i.id === google.id);
  ok('received_count incremented', gInt.receivedCount >= 4, gInt.receivedCount);
  ok('last_received timestamped', !!gInt.lastReceived);

  // B must not see any of it
  const bSees = await B.call('GET', '/api/bootstrap');
  ok('webhook leads stayed inside A\'s workspace', bSees.data.leads.length === 0, bSees.data.leads.length);
}

/* ================================================================ */
section('10. Live updates over SSE');
{
  const events = [];
  const ac = new AbortController();
  const streamed = fetch(BASE + '/api/events', {
    headers: { Cookie: A.cookie, Accept: 'text/event-stream' },
    signal: ac.signal
  }).then(async res => {
    ok('SSE stream opens', res.status === 200, res.status);
    ok('correct content type', (res.headers.get('content-type') || '').includes('text/event-stream'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) > -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (frame.match(/^event: (.+)$/m) || [])[1];
        const data = (frame.match(/^data: (.+)$/m) || [])[1];
        if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
      }
    }
  }).catch(() => {});

  await new Promise(r => setTimeout(r, 600));   // let LISTEN attach

  // A webhook delivery should reach the stream — the path that matters most,
  // since it proves NOTIFY crosses from an unauthenticated request to a session.
  await jar().call('POST', '/hook/' + token, { full_name: 'Live Update Test', email: `live${stamp}@x.lk` });
  const created = await A.call('POST', '/api/leads', { lead: { name: 'Direct Insert', value: 1 } });
  const directId = created.data.leads[0].id;
  await A.call('PATCH', '/api/leads/' + directId, { lead: { name: 'Direct Insert', stage: 'Won', value: 2 } });
  await A.call('DELETE', '/api/leads', { ids: [directId] });

  await new Promise(r => setTimeout(r, 1500));
  ac.abort();
  await streamed;

  ok('webhook insert pushed to the browser', events.some(e => e.ev === 'lead_insert' && e.data.name === 'Live Update Test'), events.map(e => e.ev));
  ok('direct insert pushed', events.some(e => e.ev === 'lead_insert' && e.data.name === 'Direct Insert'));
  ok('update pushed', events.some(e => e.ev === 'lead_update' && e.data.stage === 'Won'));
  ok('delete pushed', events.some(e => e.ev === 'lead_delete' && e.data.id === directId));
  ok('payload carries full lead shape', events.some(e => e.ev === 'lead_insert' && typeof e.data.value === 'number' && 'createdAt' in e.data));
}

/* ================================================================ */
section('11. Sheet links');
{
  let r = await A.call('POST', '/api/sheets', { name: 'Expo list', url: 'https://docs.google.com/spreadsheets/d/1ABC/edit#gid=7', provider: 'Google Sheets', sourceTag: 'Expo' });
  ok('sheet link created', r.status === 200, r.data);
  const sid = r.data.sheet.id;
  ok('skipDupes defaults true', r.data.sheet.skipDupes === true);

  r = await A.call('POST', '/api/sheets', { name: 'Bad', url: 'ftp://nope' });
  ok('rejects a non-http url', r.status === 400, r.data);

  r = await A.call('PATCH', '/api/sheets/' + sid, { lastError: 'sign-in required' });
  ok('sync error recorded', r.status === 200 && r.data.sheet.lastError === 'sign-in required', r.data);

  r = await B.call('PATCH', '/api/sheets/' + sid, { name: 'Stolen', url: 'https://x.lk/a.csv' });
  ok('B cannot edit A\'s sheet link', r.status === 404, r.status);

  r = await A.call('DELETE', '/api/sheets/' + sid);
  ok('sheet link deleted', r.data?.deleted === 1, r.data);
}

/* ================================================================ */
section('12. AI endpoints degrade cleanly with no key');
{
  const r = await A.call('GET', '/api/ai/status');
  ok('status reports unavailable', r.status === 200 && r.data.available === false, r.data);
  const s = await A.call('POST', '/api/ai/score/' + leadId);
  ok('scoring returns 503, not a crash', s.status === 503, s.status);
  const d = await A.call('POST', '/api/ai/draft/' + leadId);
  ok('drafting returns 503, not a crash', d.status === 503, d.status);
}

/* ================================================================ */
section('13. Logout invalidates the session');
{
  const r = await A.call('POST', '/api/auth/logout');
  ok('logout succeeds', r.status === 200, r.data);
  const after = await A.call('GET', '/api/bootstrap');
  ok('session no longer works', after.status === 401, after.status);
}

/* ================================================================ */
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
