// A second tab that was asleep while you logged out and in again mustn't end the new login.
// Two tabs share one saved login (localStorage). Tab B is frozen, as Chrome freezes background
// tabs (and a sleeping laptop stops every page); tab A logs out, which ends the old session and
// tells B's socket so, then logs in again. When B wakes it handles the old session's end: it
// must not log out the login A saved meanwhile (it used to post /logout with it: A then got
// 403s, "Invalid token", and was logged out a few minutes after logging in).
//   node e2e/serve.mjs &   then   node e2e/stalelogout.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

const works = (page, token) => page.evaluate(async (t) => (await fetch('/api/profile', { headers: { Authorization: `Bearer ${t}` } })).status === 200, token);
const tokenOf = (page) => page.evaluate(() => localStorage.getItem('token'));

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const a = ann.page;
  const b = await a.context().newPage();
  // B's socket goes through here, so what the server sends it can be held back, as for a page
  // that's asleep, and delivered when it wakes.
  let held = null;
  await b.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => (held ? held.push(() => ws.send(m)) : ws.send(m)));
    server.onClose((code, reason) => (held ? held.push(() => ws.close({ code, reason })) : ws.close({ code, reason })));
  });
  b.on('pageerror', (e) => console.log('tab B error:', e.message));
  await b.goto(`${BASE}/`);
  await b.waitForSelector('#dm-main', { timeout: 20000 });
  await b.waitForLoadState('networkidle');
  console.log('ann has the app open in two tabs');

  const logouts = [];
  b.on('request', (r) => { if (r.url().endsWith('/api/logout')) logouts.push(r.headers().authorization); });
  let reloads = 0;
  b.on('load', () => { reloads += 1; });
  held = [];
  console.log('tab B asleep (its socket hears nothing)');

  await a.goto(`${BASE}/settings`);
  await a.click('.settings-nav-item:has-text("Log Out")');
  await a.click('[role="dialog"] button:has-text("Log Out")');
  await a.waitForSelector('input[placeholder="Username"]', { timeout: 15000 });
  await a.fill('input[placeholder="Username"]', ann.name);
  await a.fill('input[placeholder="Password"]', ann.password);
  await a.click('button:has-text("Login")');
  await a.waitForSelector('#dm-main', { timeout: 20000 });
  const fresh = await tokenOf(a);
  console.log('tab A logged out and in again');

  // B wakes: its socket hears its login ended (session_revoked, then closed).
  const wake = held;
  held = null;
  wake.forEach((deliver) => deliver());
  for (let i = 0; i < 100 && reloads === 0; i += 1) await a.waitForTimeout(100);
  await b.waitForSelector('#dm-main', { timeout: 20000 });
  await a.waitForTimeout(3000);

  await shot(a, '01-tab-a');
  await shot(b, '02-tab-b');
  if (logouts.includes(`Bearer ${fresh}`)) throw new Error('tab B logged out with the new login');
  if (!(await works(a, fresh))) throw new Error("tab B ended tab A's new login");
  if ((await tokenOf(a)) !== fresh) throw new Error('the new login was forgotten');
  if (!(await a.isVisible('#dm-main'))) throw new Error('tab A left the app');
  if (reloads !== 1) throw new Error(`tab B should reload once onto the new login, loaded ${reloads} times`);
  console.log('tab B woke, reloaded onto the new login; the new login still works in both tabs');
  console.log('OK');
} finally {
  await browser.close();
}
