// Sign-ups (server/signups.js): an admin switches Settings → Admin → Sign-ups to approval, a new
// account waits (only the waiting page), shows up live in the admin's list, and opens the app by
// itself once approved; a declined one (on a phone) is logged out. Then invite only: no invite or
// a bad one is refused, an invite link fills the code in and lets them straight in.
//   node e2e/serve.mjs &   then   node e2e/signups.mjs [dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// A visitor signing up (not through signUp: they may not get into the app). Stops at the
// page after the recovery code.
async function register(browser, name, { contextOptions = { viewport: { width: 1100, height: 750 } }, url = `${BASE}/`, invite } = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  const username = `${name}${String(Date.now()).slice(-5)}`;
  await page.goto(url);
  await page.fill('input[placeholder="New Username"]', username);
  await page.fill('input[placeholder="New Password"]', `correct horse battery ${name}`);
  if (invite != null) await page.fill('input[name="invite"]', invite);
  // The terms of use tick (Login.jsx): registering needs it.
  await page.check('label:has-text("I agree to the") input');
  return { page, username, submit: async () => {
    await page.click('button:has-text("Register")');
    await page.waitForSelector('[aria-label="Recovery code"]', { timeout: 20000 });
    await page.check('text=I\'ve saved my recovery code');
    await page.click('button:has-text("Continue")');
  } };
}

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  await admin.page.goto(`${BASE}/settings`);
  await admin.page.waitForSelector('#admin-signupMode');
  if ((await admin.page.inputValue('#admin-signupMode')) !== 'open') throw new Error('not open by default');
  await admin.page.selectOption('#admin-signupMode', 'request');
  await admin.page.waitForSelector('.admin-setting-state:has-text("Set here")');
  await admin.page.waitForSelector('text=Nobody is waiting.');

  // Someone signs up: the invite is optional, and they only get the waiting page.
  const newbie = await register(browser, 'newbie');
  await newbie.page.waitForSelector('text=wait for an admin to approve them');
  if (await newbie.page.getAttribute('input[name="invite"]', 'required') !== null) throw new Error('invite required in request mode');
  await shot(newbie.page, 'signup-request-form');
  await newbie.submit();
  await newbie.page.waitForSelector('text=Waiting for approval');
  if (await newbie.page.$('#dm-main')) throw new Error('pending account sees the app');
  await newbie.page.goto(`${BASE}/dm`);
  await newbie.page.waitForSelector('text=Waiting for approval');
  await shot(newbie.page, 'waiting');

  // The admin's open panel lists them without a reload; approving opens the app for them, live.
  await admin.page.waitForSelector(`.admin-list li:has-text("${newbie.username}")`, { timeout: 10000 });
  await shot(admin.page, 'admin-request');
  await admin.page.click(`.admin-list li:has-text("${newbie.username}") button:has-text("Approve")`);
  await newbie.page.waitForSelector('#dm-main', { timeout: 15000 });
  await admin.page.waitForSelector('text=Nobody is waiting.');

  // On a phone: waiting page, then declined: logged out, back at the login page.
  const phone = await register(browser, 'phoney', { contextOptions: { ...devices['Pixel 7'] } });
  await phone.submit();
  await phone.page.waitForSelector('text=Waiting for approval');
  await shot(phone.page, 'waiting-phone');
  await admin.page.waitForSelector(`.admin-list li:has-text("${phone.username}")`, { timeout: 10000 });
  await admin.page.click(`.admin-list li:has-text("${phone.username}") button:has-text("Decline")`);
  await phone.page.waitForSelector('input[placeholder="New Username"]', { timeout: 15000 });

  // Invite only.
  await admin.page.selectOption('#admin-signupMode', 'invite');
  await admin.page.waitForFunction(() => document.querySelector('#admin-signupMode')?.value === 'invite' && !document.querySelector('#admin-signupMode').disabled);
  await admin.page.click('button:has-text("Create invite")');
  const link = (await admin.page.textContent('.admin-invite code', { timeout: 10000 })).trim();
  if (!/\/join\/[A-Za-z0-9]+$/.test(link)) throw new Error(`odd invite link ${link}`);
  await admin.page.waitForSelector('text=Used 0 of 1');
  await shot(admin.page, 'admin-invites');

  const refused = await register(browser, 'nocode', { invite: 'notacode' });
  if (await refused.page.getAttribute('input[name="invite"]', 'required') === null) throw new Error('invite not required');
  await refused.page.click('button:has-text("Register")');
  await refused.page.waitForSelector('text=That invite doesn\'t work');
  await shot(refused.page, 'invite-refused');

  // The link (on this test's own address) fills the code in, and lets them straight in.
  const code = link.split('/join/')[1];
  const invited = await register(browser, 'invited', { url: `${BASE}/join/${code}` });
  if ((await invited.page.inputValue('input[name="invite"]')) !== code) throw new Error('invite not filled in from the link');
  await invited.submit();
  await invited.page.waitForSelector('#dm-main', { timeout: 20000 });
  // Used up.
  await admin.page.reload();
  await admin.page.waitForSelector('#admin-signupMode');
  if (await admin.page.$('.admin-invite code')) throw new Error('used-up invite still listed');

  await admin.page.selectOption('#admin-signupMode', 'open');
  console.log('signups: ok');
} catch (err) {
  console.error('signups: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
