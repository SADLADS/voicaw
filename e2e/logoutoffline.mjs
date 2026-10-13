// Logging out while the API can't be reached (MODE=abort: connection refused; MODE=502: nginx's
// Bad Gateway; MODE=hang: no answer, so logout gives up on it after 5 s): the login form comes
// and the token is gone; when the API comes back, logging in again works. Then a saved login
// while the API doesn't answer: "Can't reach Voicaw" has Log out on this device, which ends at
// the login form (no cookie to clear: the login is in localStorage).
//   node e2e/serve.mjs &   then   node e2e/logoutoffline.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const browser = await launchChrome();
const modes = (process.env.MODE || 'abort,502,hang').split(',');
let failed = false;
for (const mode of modes) {
  const u = await signUp(browser, 'out');
  const { page } = u;
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${mode}] console:`, m.text().slice(0, 200)); });
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('.settings-nav-item.danger');
  const handler = (route) => {
    if (mode === 'abort') return route.abort('connectionrefused');
    if (mode === '502') return route.fulfill({ status: 502, body: 'Bad Gateway' });
    return undefined; // hang: never answered
  };
  await page.route('**/api/**', handler);
  await page.click('.settings-nav-item.danger');
  // The confirm button has the focus.
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  const reachedLogin = await page.waitForSelector('input[placeholder="Username"]', { timeout: 15000 }).then(() => true, () => false);
  const tokenLeft = await page.evaluate(() => Boolean(localStorage.getItem('token')));
  console.log(`[${mode}] login form while down: ${reachedLogin} after ${Date.now() - t0} ms; token left: ${tokenLeft}`);
  if (!reachedLogin || tokenLeft) failed = true;
  if (shots) await page.screenshot({ path: `${shots}/${mode}-down.png` });
  // The API comes back: reload, then log in again.
  await page.unroute('**/api/**', handler);
  await page.reload();
  const form = await page.waitForSelector('input[placeholder="Username"]', { timeout: 20000 }).then(() => true, () => false);
  if (!form) {
    console.log(`[${mode}] FAIL: no login form after the API came back:`, (await page.textContent('body')).slice(0, 200));
    if (shots) await page.screenshot({ path: `${shots}/${mode}-back.png` });
    failed = true;
    await page.context().close();
    continue;
  }
  await page.fill('input[placeholder="Username"]', u.name);
  await page.fill('input[placeholder="Password"]', u.password);
  await page.click('button[type="submit"]');
  const inApp = await page.waitForSelector('#dm-main', { timeout: 20000 }).then(() => true, () => false);
  console.log(`[${mode}] logged in again: ${inApp}`);
  if (!inApp) {
    console.log(`[${mode}] FAIL:`, (await page.textContent('body')).slice(0, 300));
    if (shots) await page.screenshot({ path: `${shots}/${mode}-relogin.png` });
    failed = true;
  }
  // A saved login, the API not answering: the unreachable screen's way out.
  if (mode === 'hang' && inApp) {
    await page.route('**/api/**', handler);
    await page.reload();
    await page.waitForSelector('.auth-unreachable button', { timeout: 20000 });
    if (shots) await page.screenshot({ path: `${shots}/unreachable.png` });
    await page.click('.auth-unreachable button');
    const out = await page.waitForSelector('input[placeholder="Username"]', { timeout: 10000 }).then(() => true, () => false);
    const left = await page.evaluate(() => Boolean(localStorage.getItem('token')));
    console.log(`[${mode}] unreachable screen's log out: login form ${out}, token left ${left}`);
    if (!out || left) failed = true;
  }
  await page.context().close();
}
await browser.close();
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
