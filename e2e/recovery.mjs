// Password change and recovery codes: sign up (code shown), change the password in
// Settings, reset it with the recovery code while logged out (old messages still readable),
// make a new code (the old one stops working); an account from before recovery codes gets
// one when it logs in.
//   node e2e/serve.mjs &   then   node e2e/recovery.mjs [screenshot dir]
import request from 'supertest';
import { BASE, launchChrome, signUp, openChat, send, devices } from './helpers.mjs';
import { registerUser } from '../server/test/helpers/authFlow.js';

const shots = process.argv[2];
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

async function freshPage(browser, options = { viewport: { width: 1100, height: 750 } }) {
  const page = await (await browser.newContext(options)).newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${BASE}/`);
  return page;
}

async function logIn(browser, username, password) {
  const page = await freshPage(browser);
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder="Password"]', password);
  await page.click('button:has-text("Login")');
  await Promise.race([
    page.waitForSelector('#dm-main', { timeout: 20000 }),
    page.waitForSelector('.login-error', { timeout: 20000 }),
  ]);
  return page;
}

async function recover(browser, username, code, password, options) {
  const page = await freshPage(browser, options);
  await page.click('button:has-text("Forgot password?")');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="recovery-code"]', code);
  await page.fill('input[name="new-password"]', password);
  await page.fill('input[name="confirm-password"]', password);
  await shot(page, `recover-${options ? 'phone' : 'desktop'}`);
  await page.click('button:has-text("Reset password and log in")');
  await Promise.race([
    page.waitForSelector('#dm-main', { timeout: 20000 }),
    page.waitForSelector('.login-error', { timeout: 20000 }),
  ]);
  return page;
}

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const browser = await launchChrome();
try {
  // The code screen, on a phone.
  const phone = await freshPage(browser, devices['Pixel 7']);
  await phone.fill('input[placeholder="New Username"]', `phone${String(Date.now()).slice(-5)}`);
  await phone.fill('input[placeholder="New Password"]', 'correct horse battery phone');
  await phone.check('label:has-text("I agree to the") input');
  await phone.click('button:has-text("Register")');
  await phone.waitForSelector('[aria-label="Recovery code"]');
  await shot(phone, 'code-phone');

  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  check(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/.test(alice.recoveryCode), 'sign-up shows a recovery code');
  await openChat(bob.page, alice.id);
  await send(bob.page, 'secret before the reset');

  // Change the password in Settings.
  await alice.page.goto(`${BASE}/settings`);
  await alice.page.fill('input[placeholder="Current password"]', alice.password);
  await alice.page.fill('input[placeholder="New password"]', 'second password 1');
  await alice.page.fill('input[placeholder="New password again"]', 'second password 1');
  await alice.page.click('button:has-text("Change password")');
  await alice.page.waitForSelector('text=Password changed.', { timeout: 20000 });
  await shot(alice.page, 'settings');
  check(true, 'password changed in Settings');
  check(await (await logIn(browser, alice.name, alice.password)).isVisible('.login-error'), 'old password refused');
  check(await (await logIn(browser, alice.name, 'second password 1')).isVisible('#dm-main'), 'new password works');

  // Forgot it: the recovery code, typed sloppily (lower case, spaces).
  const sloppy = alice.recoveryCode.toLowerCase().replace(/-/g, ' ');
  const recovered = await recover(browser, alice.name, sloppy, 'third password 1');
  check(await recovered.isVisible('#dm-main'), 'recovery code resets the password and logs in');
  await openChat(recovered, bob.id);
  await recovered.waitForSelector('text=secret before the reset', { timeout: 20000 });
  check(true, 'old messages still readable after the reset');
  check(await (await logIn(browser, alice.name, 'second password 1')).isVisible('.login-error'), 'previous password refused');

  // A new code replaces the old one.
  await recovered.goto(`${BASE}/settings`);
  await recovered.click('button:has-text("Make a new recovery code")');
  await recovered.fill('input[placeholder="Your password"]', 'third password 1');
  await recovered.click('button:has-text("Show my new code")');
  const newCode = (await recovered.textContent('[aria-label="Recovery code"]', { timeout: 20000 })).trim();
  await shot(recovered, 'settings-new-code');
  check(newCode !== alice.recoveryCode, 'Settings makes a new code');
  const stale = await recover(browser, alice.name, alice.recoveryCode, 'fourth password 1');
  check((await stale.textContent('.login-error')) === 'Wrong username or recovery code', 'old code refused');
  const again = await recover(browser, alice.name, newCode, 'fourth password 1', devices['Pixel 7']);
  check(await again.isVisible('#dm-main'), 'new code works (phone)');
  // An account from before recovery codes (registered without one, through the API).
  const oldName = `old${String(Date.now()).slice(-5)}`;
  await registerUser(BASE, request, oldName, 'old account password');
  const first = await freshPage(browser);
  await first.fill('input[placeholder="Username"]', oldName);
  await first.fill('input[placeholder="Password"]', 'old account password');
  await first.click('button:has-text("Login")');
  const oldCode = (await first.textContent('[aria-label="Recovery code"]', { timeout: 20000 })).trim();
  await shot(first, 'login-code');
  check(true, 'logging in to an account without a code shows one');
  // Closing the tab before continuing stores nothing: the next login offers a new one.
  const second = await freshPage(browser);
  await second.fill('input[placeholder="Username"]', oldName);
  await second.fill('input[placeholder="Password"]', 'old account password');
  await second.click('button:has-text("Login")');
  const code2 = (await second.textContent('[aria-label="Recovery code"]', { timeout: 20000 })).trim();
  check(code2 !== oldCode, 'not stored until confirmed: asked again next login');
  await second.check("text=I've saved my recovery code");
  await second.click('button:has-text("Continue")');
  await second.waitForSelector('#dm-main', { timeout: 20000 });
  check(!(await second.isVisible('text=Set up a recovery code')), 'in the app, no set-up banner');
  check((await (await recover(browser, oldName, oldCode, 'x new password 1')).textContent('.login-error')) === 'Wrong username or recovery code', 'the unconfirmed code does nothing');
  check(await (await recover(browser, oldName, code2, 'x new password 1')).isVisible('#dm-main'), 'the confirmed code works');
  check(await (await logIn(browser, oldName, 'x new password 1')).isVisible('#dm-main'), 'later logins go straight in');
  console.log('recovery: ok');
} catch (err) {
  console.error('recovery: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
