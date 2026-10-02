// Settings → Devices in real browsers: one account logged in on a computer, a phone and a
// second computer. The list shows each (this device, online now, the others), logging the phone
// out sends it straight back to the login page (and its token stops working), and "Log out all
// other devices" does the same to the rest while this one stays. Also the section on a phone,
// and logging out normally ending the session on the server.
//   node e2e/serve.mjs &   then   node e2e/devices.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

async function logIn(browser, username, password, contextOptions = { viewport: { width: 1100, height: 750 } }) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder="Password"]', password);
  await page.click('button:has-text("Login")');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  return page;
}

// Whether `token` still works.
const works = (page, token) => page.evaluate(async (t) => (await fetch('/api/profile', { headers: { Authorization: `Bearer ${t}` } })).status === 200, token);
const tokenOf = (page) => page.evaluate(() => localStorage.getItem('token'));
const atLogin = (page) => page.waitForSelector('input[placeholder="Username"]', { timeout: 15000 });

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const a = ann.page;
  const phone = await logIn(browser, ann.name, ann.password, devices['Pixel 7']);
  const other = await logIn(browser, ann.name, ann.password);
  const phoneToken = await tokenOf(phone);
  console.log('ann is logged in on a computer, a phone and another computer');

  await a.goto(`${BASE}/settings#devices`);
  const rows = a.locator('#settings-devices .device-row');
  await rows.nth(2).waitFor();
  if ((await rows.count()) !== 3) throw new Error(`expected 3 devices, got ${await rows.count()}`);
  const current = a.locator('#settings-devices .device-row[data-current]');
  if (!(await current.textContent()).includes('This device')) throw new Error('this device not marked');
  if (await current.locator('button').count()) throw new Error('this device has a log out button');
  await a.locator('#settings-devices .device-row:has-text("Chrome on Android")').waitFor();
  // Both others have the app open: online now.
  await a.waitForFunction(() => document.querySelectorAll('#settings-devices .device-online').length === 3);
  await a.locator('#settings-devices').scrollIntoViewIfNeeded();
  await shot(a, '01-devices');
  console.log('three devices listed: this one, the phone, the other computer; all online');

  // Log the phone out: it's back at the login page by itself, and its old token is dead.
  await a.click('#settings-devices .device-row:has-text("Chrome on Android") button:has-text("Log out")');
  await a.waitForFunction(() => document.querySelectorAll('#settings-devices .device-row').length === 2);
  await atLogin(phone);
  if (await tokenOf(phone)) throw new Error('phone kept its token');
  if (await works(a, phoneToken)) throw new Error("the phone's token still works");
  await shot(phone, '02-phone-logged-out');
  console.log('phone logged out from the computer: back at the login page, token refused');

  // Log every other device out, after the confirmation.
  await a.click('#settings-devices button:has-text("Log out all other devices")');
  await a.waitForSelector('[role="dialog"]:has-text("The other device will have to log in again")');
  await shot(a, '03-confirm');
  await a.click('[role="dialog"] button:has-text("Log out")');
  await a.waitForFunction(() => document.querySelectorAll('#settings-devices .device-row').length === 1);
  if (await a.isVisible('#settings-devices button:has-text("Log out all other devices")')) throw new Error('button still there');
  await atLogin(other);
  if (!(await works(a, await tokenOf(a)))) throw new Error('this device was logged out too');
  await shot(a, '04-only-this-one');
  console.log('all other devices logged out; this one stays');

  // The section on a phone, with the computer listed too.
  const phone2 = await logIn(browser, ann.name, ann.password, devices['Pixel 7']);
  await phone2.goto(`${BASE}/settings#devices`);
  await phone2.locator('#settings-devices .device-row').nth(1).waitFor();
  await phone2.locator('#settings-devices').scrollIntoViewIfNeeded();
  const overflow = await phone2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Devices section is wider than the phone');
  await shot(phone2, '05-phone-section');
  console.log('section fits on a phone');

  // Logging out normally ends the session on the server too.
  const phone2Token = await tokenOf(phone2);
  await phone2.goto(`${BASE}/settings#log-out`);
  await phone2.click('#settings-log-out button:has-text("Log out")');
  await atLogin(phone2);
  if (await works(a, phone2Token)) throw new Error('logged-out token still works');
  await a.reload();
  await a.locator('#settings-devices .device-row').first().waitFor();
  if ((await a.locator('#settings-devices .device-row').count()) !== 1) throw new Error('logged-out device still listed');
  console.log('logging out ends the session: token refused, gone from the list');
  console.log('OK');
} finally {
  await browser.close();
}
