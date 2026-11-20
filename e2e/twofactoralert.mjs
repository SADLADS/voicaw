// Security audit L2 (2026-11-19): logging in names its attempt (`perAttempt`, `loginId`), and the
// banner warning about wrong two-factor codes. Run with serve.mjs up:
//   node e2e/twofactoralert.mjs [dir]
// 1. Sign up, then log in again in a fresh browser through the form: the login sends
//    perAttempt and its loginId, and another login started for the same name in between doesn't
//    break it.
// 2. The banner: /profile's twoFactorFailures (made up here: getting real wrong codes needs
//    two-factor set up, which twofactor.mjs covers) shows it over every page in dark, light and a
//    phone; Dismiss tells the server and it's gone; Change password opens Settings → My Account.
import { launchChrome, signUp, loginToken, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };
const browser = await launchChrome();
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

try {
  const alice = await signUp(browser, 'tfalert');

  // 1. A real login through the form, with someone else starting one for the name meanwhile.
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  const bodies = [];
  await page.route('**/api/initiatelogin', async (route) => {
    bodies.push(JSON.parse(route.request().postData()));
    const response = await route.fetch();
    // Someone else starts a login for the same name between the two steps (an old app's way and
    // a new one's).
    for (const perAttempt of [undefined, true]) {
      await fetch(`${BASE}/api/initiatelogin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIdentifier: alice.name, startLoginRequest: bodies[0].startLoginRequest, perAttempt }),
      });
    }
    await route.fulfill({ response });
  });
  const finals = [];
  page.on('request', (req) => { if (req.url().endsWith('/api/finaliselogin')) finals.push(JSON.parse(req.postData())); });
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="Username"]', alice.name);
  await page.fill('input[placeholder="Password"]', alice.password);
  await page.click('button[type="submit"]:has-text("Login")');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  check(bodies[0]?.perAttempt === true, 'the login form sends perAttempt');
  check(typeof finals[0]?.loginId === 'string' && finals[0].loginId.length > 10, 'and its loginId with the finished login');
  check(true, 'logged in although someone else started logins for the name in between');
  await context.close();

  // 2. The banner.
  for (const [label, options, theme] of [
    ['dark', { viewport: { width: 1100, height: 750 } }, 'dark'],
    ['light', { viewport: { width: 1100, height: 750 } }, 'light'],
    ['phone', devices['Pixel 7'], 'dark'],
  ]) {
    const ctx = await browser.newContext(options);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log(`[${label}] page error:`, e.message));
    const token = await loginToken(alice.page);
    await ctx.addInitScript(([t, th]) => {
      localStorage.setItem('token', t);
      localStorage.setItem('theme', th);
    }, [token, theme]);
    let failures = 7;
    await p.route('**/api/profile', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, twoFactorFailures: failures } });
    });
    let seen = 0;
    p.on('request', (req) => { if (req.url().endsWith('/api/two-factor/failures/seen')) seen++; });
    await p.goto(`${BASE}/`);
    const banner = p.locator('.two-factor-alert');
    await banner.waitFor({ timeout: 20000 });
    check((await banner.textContent()).includes('7 wrong two-factor codes were typed'), `${label}: banner says how many`);
    const box = await banner.boundingBox();
    const width = await p.evaluate(() => window.innerWidth);
    check(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: banner fits the window (${Math.round(box?.width)} of ${width})`);
    await shot(p, `twofactoralert-${label}`);
    if (label === 'dark') {
      await p.click('.two-factor-alert >> text=Change password');
      await p.waitForURL(/\/settings\/account/);
      check(true, 'Change password opens Settings → My Account');
      check(await banner.count() === 0, 'and the banner goes');
    } else {
      await p.click('.two-factor-alert [aria-label="Dismiss"]');
      check(await banner.count() === 0, `${label}: Dismiss hides it`);
    }
    await p.waitForTimeout(300);
    check(seen === 1, `${label}: the server is told it's been seen`);
    failures = 0;
    await p.reload();
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(1000);
    check(await banner.count() === 0, `${label}: not shown again after a reload`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
