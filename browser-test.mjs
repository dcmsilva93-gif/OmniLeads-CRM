// Loads the real page in Chromium and drives the UI, to verify the client
// rewiring (auth gate, API calls, live updates) actually works in a browser.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:3456';
let fails = 0, passes = 0;
const ok = (n, c, x) => { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const browser = await chromium.launch({
  // Use the Chromium already on the image rather than downloading one.
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(e.message));

const email = `ui${Date.now()}@acme.lk`;

try {
  console.log('\n1. Page loads and shows the login gate');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('login gate visible', await page.isVisible('#auth-gate'));
  ok('app shell hidden behind it', await page.locator('#app-shell').evaluate(el => el.classList.contains('invisible')));
  ok('no uncaught page errors on load', pageErrors.length === 0, pageErrors);

  console.log('\n2. Signing up');
  await page.click('button:has-text("Create a workspace")');
  ok('signup fields revealed', await page.isVisible('#auth-company'));
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', 'a good password 1');
  await page.fill('#auth-company', 'Browser Test Co');
  await page.click('#auth-submit');
  await page.waitForSelector('#auth-gate.hidden', { timeout: 15000 });
  ok('gate dismissed after signup', await page.locator('#auth-gate').evaluate(el => el.classList.contains('hidden')));
  ok('app shell now visible', await page.locator('#app-shell').evaluate(el => !el.classList.contains('invisible')));
  ok('CRM name from company', (await page.textContent('#sidebar-crm-name')).includes('Browser Test Co'));
  ok('signed-in email shown', (await page.textContent('#user-email')).includes(email));
  await page.waitForFunction(() => /saved/i.test(document.getElementById('sync-status')?.innerText || ''), { timeout: 10000 });
  ok('sync status reports saved', /saved/i.test(await page.innerText('#sync-status')));

  console.log('\n3. Adding a lead through the UI');
  await page.click('button:has-text("Add lead")');
  await page.waitForSelector('#lead-modal.flex');
  await page.fill('#lead-name', 'Suresh Bandara');
  await page.fill('#lead-company', 'Kandy Exports');
  await page.fill('#lead-email', 'suresh@kandy.lk');
  await page.fill('#lead-value', '32000');
  await page.click('#lead-form button[type="submit"]');
  await page.waitForTimeout(1500);
  ok('lead count is 1, not double-counted', (await page.textContent('#nav-lead-count')).trim() === '1', await page.textContent('#nav-lead-count'));
  ok('dashboard total updated', (await page.textContent('#stat-total-leads')).trim() === '1');
  const persisted = await page.evaluate(async () => {
    const r = await fetch('/api/bootstrap', { credentials: 'same-origin' });
    const d = await r.json();
    return d.leads.map(l => ({ name: l.name, value: l.value, id: l.id }));
  });
  ok('lead persisted server-side', persisted.length === 1 && persisted[0].name === 'Suresh Bandara', persisted);
  ok('value stored as a number', persisted[0].value === 32000, persisted[0].value);
  ok('card carries a real uuid, not tmp_', /^[0-9a-f-]{36}$/.test(persisted[0].id), persisted[0].id);

  console.log('\n4. Pipeline board renders the lead');
  await page.click('#nav-pipeline');
  await page.waitForTimeout(500);
  ok('board shows the lead', await page.isVisible('text=Suresh Bandara'));
  const colCount = await page.locator('#kanban-columns-wrapper > div').count();
  ok('six stage columns', colCount === 6, colCount);

  console.log('\n5. Stage change writes through');
  await page.click('button:has-text("List")');
  await page.waitForTimeout(400);
  await page.selectOption('#list-view-tbody select', 'Qualified');
  await page.waitForTimeout(1200);
  const stage = await page.evaluate(async () => {
    const d = await (await fetch('/api/bootstrap', { credentials: 'same-origin' })).json();
    return d.leads[0].stage;
  });
  ok('stage saved to the server', stage === 'Qualified', stage);

  console.log('\n6. A webhook lead arrives live, with no refresh');
  const token = await page.evaluate(async () => {
    const d = await (await fetch('/api/bootstrap', { credentials: 'same-origin' })).json();
    const g = d.integrations.find(i => i.system === 'Google Ads');
    await fetch('/api/integrations/' + g.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ on: true })
    });
    return g.webhookToken;
  });
  ok('connector activated and token read', !!token);

  const before = Number((await page.textContent('#nav-lead-count')).trim());
  // Posted from Node, entirely outside the browser session.
  const res = await fetch(`${BASE}/hook/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Live', last_name: 'Arrival', email: `live${Date.now()}@x.lk`, budget: 'Rs. 19,500' })
  });
  ok('webhook accepted the post', res.ok, res.status);

  await page.waitForFunction(n => document.getElementById('nav-lead-count')?.innerText.trim() === String(n), before + 1, { timeout: 15000 });
  ok('UI updated itself via SSE', Number((await page.textContent('#nav-lead-count')).trim()) === before + 1);
  ok('new lead name assembled correctly', await page.isVisible('text=Live Arrival'));
  ok('a toast announced it', await page.isVisible('#toast-container >> text=New lead'));

  console.log('\n7. Settings persist');
  await page.click('#nav-settings');
  await page.waitForTimeout(400);
  await page.selectOption('#setting-currency', 'LKR');
  await page.waitForTimeout(1500);
  const cur = await page.evaluate(async () => {
    const d = await (await fetch('/api/bootstrap', { credentials: 'same-origin' })).json();
    return d.settings.currency;
  });
  ok('currency saved', cur === 'LKR', cur);
  ok('workspace id shown for inviting', /^[0-9a-f-]{36}$/.test(await page.inputValue('#workspace-id-display')));
  ok('member roster rendered', (await page.innerText('#members-list')).includes(email));

  console.log('\n8. AI controls stay hidden with no key configured');
  ok('score-all button hidden', await page.locator('[data-ai-only]').first().evaluate(el => el.classList.contains('hidden')));

  console.log('\n9. Reload keeps the session');
  // 'networkidle' never settles: the live-update stream is a long-lived request.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ok('still signed in after reload', await page.locator('#auth-gate').evaluate(el => el.classList.contains('hidden')));
  ok('leads still shown', Number((await page.textContent('#nav-lead-count')).trim()) === 2, await page.textContent('#nav-lead-count'));
  ok('currency survived as LKR', (await page.innerText('#stat-open-value')).includes('Rs'), await page.innerText('#stat-open-value'));

  console.log('\n10. Sign out');
  await page.click('button:has-text("Sign out")');
  await page.waitForSelector('#auth-gate:not(.hidden)', { timeout: 10000 });
  ok('login gate returns', await page.isVisible('#auth-gate'));
  const after = await page.evaluate(async () => (await fetch('/api/bootstrap', { credentials: 'same-origin' })).status);
  ok('session really invalidated', after === 401, after);

  console.log('\n11. Console hygiene');
  const realErrors = consoleErrors.filter(e => !/401|Failed to load resource/.test(e));
  ok('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 5));
  ok('no uncaught exceptions all run', pageErrors.length === 0, pageErrors.slice(0, 5));

} catch (err) {
  fails++;
  console.log('\n  FAIL  threw: ' + err.message);
  await page.screenshot({ path: '/var/lib/postgresql/failure.png' }).catch(() => {});
} finally {
  await browser.close();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
