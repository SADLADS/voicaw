// Two-factor authentication: Settings → My Account sets it up (QR code and key; the code is
// worked out here from the key shown, as an authenticator app would), logging in then asks for
// a code (a wrong one refused, the app's code works, a backup code works once, on a phone too),
// resetting the password with the recovery code asks for one, and turning it off needs the
// password and a code.
//   node e2e/serve.mjs &   then   node e2e/twofactor.mjs [screenshot dir]
import crypto from 'node:crypto';
import { BASE, launchChrome, signUp, devices } from './helpers.mjs';

const shots = process.argv[2];
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// RFC 6238, as authenticator apps do it: `offset` steps from now.
function totp(base32, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.replace(/\s/g, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const at = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(at) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function freshPage(browser, options = { viewport: { width: 1100, height: 750 } }) {
  const page = await (await browser.newContext(options)).newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${BASE}/`);
  return page;
}

// Logs in with the password; resolves once the code screen (or an error) shows.
async function passwordStep(browser, user, options) {
  const page = await freshPage(browser, options);
  await page.fill('input[placeholder="Username"]', user.name);
  await page.fill('input[placeholder="Password"]', user.password);
  await page.click('button:has-text("Login")');
  await Promise.race([
    page.waitForSelector('input[name="two-factor-code"]', { timeout: 20000 }),
    page.waitForSelector('#dm-main', { timeout: 20000 }),
  ]);
  return page;
}

async function submitCode(page, code) {
  await page.fill('input[name="two-factor-code"]', code);
  await page.click('button:has-text("Log in")');
  await Promise.race([
    page.waitForSelector('#dm-main', { timeout: 20000 }),
    page.waitForSelector('.login-error', { timeout: 20000 }),
  ]);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const page = alice.page;

  // Set up from Settings → My Account.
  await page.goto(`${BASE}/settings/account#two-factor`);
  await page.click('button:has-text("Set up two-factor")');
  await page.waitForSelector('svg.two-factor-qr path');
  const key = (await page.textContent('[aria-label="Key for your authenticator app"]')).replace(/\s/g, '');
  check(/^[A-Z2-7]{32}$/.test(key), 'a QR code and a 32-letter key are shown');
  const qr = await page.$eval('svg.two-factor-qr', (svg) => {
    const box = svg.getBoundingClientRect();
    const light = getComputedStyle(svg.querySelector('rect')).fill;
    const dark = getComputedStyle(svg.querySelector('path')).fill;
    return { width: box.width, light, dark };
  });
  check(qr.width >= 150 && qr.light === 'rgb(255, 255, 255)' && qr.dark === 'rgb(0, 0, 0)', 'QR code is dark on light and big enough to scan');
  await page.fill('input[placeholder="Six-digit code"]', '000000');
  await page.fill('.two-factor-setup input[placeholder="Your password"]', alice.password);
  await shot(page, 'setup');
  await page.click('button:has-text("Turn on")');
  await page.waitForSelector('.two-factor-setup .error-msg', { timeout: 20000 });
  check(true, 'a wrong code is refused at set-up');
  await page.fill('input[placeholder="Six-digit code"]', totp(key));
  await page.click('button:has-text("Turn on")');
  await page.waitForSelector('[aria-label="Backup codes"] li', { timeout: 20000 });
  const backupCodes = await page.$$eval('[aria-label="Backup codes"] li', (items) => items.map((li) => li.textContent));
  check(backupCodes.length === 10 && backupCodes.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)), 'ten backup codes are shown');
  await shot(page, 'backup-codes');
  await page.check('text=I\'ve saved my backup codes');
  await page.click('.recovery-code-display button:has-text("Done")');
  await page.waitForSelector('text=10 backup codes left.');
  check(true, 'Settings says it is on, with 10 backup codes');
  await shot(page, 'on');

  // Logging in asks for a code.
  const desktop = await passwordStep(browser, alice);
  check(await desktop.isVisible('input[name="two-factor-code"]'), 'the password alone leads to the code screen');
  await shot(desktop, 'login-code');
  await submitCode(desktop, '123456');
  check(await desktop.isVisible('.login-error'), 'a wrong code is refused');
  await submitCode(desktop, totp(key, 1));
  check(await desktop.isVisible('#dm-main'), "the authenticator app's code logs in");

  // On a phone, with a backup code (typed in capitals with a space).
  const phone = await passwordStep(browser, alice, devices['Pixel 7']);
  await shot(phone, 'login-code-phone');
  const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(fits, 'the code screen fits a phone');
  await submitCode(phone, backupCodes[0].toUpperCase().replace('-', ' '));
  check(await phone.isVisible('#dm-main'), 'a backup code logs in on a phone');
  const again = await passwordStep(browser, alice);
  await submitCode(again, backupCodes[0]);
  check(await again.isVisible('.login-error'), 'the same backup code is refused the second time');

  // Forgot the password: the recovery code asks for a two-factor code too.
  const recover = await freshPage(browser);
  await recover.click('button:has-text("Forgot password?")');
  await recover.fill('input[name="username"]', alice.name);
  await recover.fill('input[name="recovery-code"]', alice.recoveryCode);
  await recover.fill('input[name="new-password"]', 'reset password 12');
  await recover.fill('input[name="confirm-password"]', 'reset password 12');
  await recover.click('button:has-text("Reset password and log in")');
  await recover.waitForSelector('input[name="two-factor-code"]', { timeout: 20000 });
  check(await recover.isVisible('text=This account has two-factor authentication'), 'recovery asks for a two-factor code');
  await shot(recover, 'recover-code');
  await recover.fill('input[name="two-factor-code"]', backupCodes[1]);
  await recover.click('button:has-text("Reset password and log in")');
  await recover.waitForSelector('#dm-main', { timeout: 20000 });
  check(true, 'recovery with a backup code resets the password and logs in');
  alice.password = 'reset password 12';

  // Turn it off: password and a code.
  await recover.goto(`${BASE}/settings/account#two-factor`);
  await recover.waitForSelector('text=8 backup codes left.', { timeout: 20000 });
  check(true, 'used backup codes are counted');
  await recover.click('button:has-text("Turn off two-factor")');
  await recover.fill('form[aria-label="Turn off two-factor"] input[placeholder="Your password"]', alice.password);
  await recover.fill('input[placeholder="Six-digit code or backup code"]', backupCodes[2]);
  await recover.click('form[aria-label="Turn off two-factor"] button[type="submit"]');
  await recover.waitForSelector('button:has-text("Set up two-factor")', { timeout: 20000 });
  check(true, 'turned off with the password and a backup code');
  const plain = await passwordStep(browser, alice);
  check(await plain.isVisible('#dm-main'), 'logging in needs only the password again');

  // Settings on a phone (set up screen fits).
  const phoneSettings = await passwordStep(browser, alice, devices['Pixel 7']);
  await phoneSettings.goto(`${BASE}/settings/account#two-factor`);
  await phoneSettings.click('button:has-text("Set up two-factor")');
  await phoneSettings.waitForSelector('svg.two-factor-qr path');
  await phoneSettings.locator('svg.two-factor-qr').scrollIntoViewIfNeeded();
  check(await phoneSettings.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'set-up fits a phone');
  await shot(phoneSettings, 'setup-phone');
  console.log('all ok');
} finally {
  await browser.close();
}
