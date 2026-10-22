// Sign-ups (server/signups.js): an admin switches Settings → Admin → Sign-ups to approval and
// makes "why do you want to join" required (the setting only shows then), a new account can't
// register without an answer, waits (only the waiting page), shows up live in the admin's list
// with its answer, and opens the app by itself once approved; a declined one (on a phone) is
// logged out. Show history lists both, with the answers and who decided; one is deleted from it.
// Then invite only: no invite or a bad one is refused, an invite link fills the code in and lets
// them straight in.
//   node e2e/serve.mjs &   then   node e2e/signups.mjs [dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// A visitor signing up (not through signUp: they may not get into the app). Stops at the
// page after the recovery code.
async function register(browser, name, { contextOptions = { viewport: { width: 1100, height: 750 } }, url = `${BASE}/`, invite, reason } = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  const username = `${name}${String(Date.now()).slice(-5)}`;
  await page.goto(url);
  await page.fill('input[placeholder="New Username"]', username);
  await page.fill('input[placeholder="New Password"]', `correct horse battery ${name}`);
  if (invite != null) await page.fill('input[name="invite"]', invite);
  if (reason != null) await page.fill('textarea[name="reason"]', reason);
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
  await admin.page.goto(`${BASE}/settings/admin`);
  await admin.page.waitForSelector('#admin-signupMode');
  if ((await admin.page.inputValue('#admin-signupMode')) !== 'open') throw new Error('not open by default');
  if (await admin.page.$('#admin-signupReason')) throw new Error('reason setting shown while sign-ups are open');
  await admin.page.selectOption('#admin-signupMode', 'request');
  await admin.page.waitForSelector('.admin-setting-state:has-text("Set here")');
  await admin.page.waitForSelector('text=Nobody is waiting.');
  // Asking why only matters now: its setting shows, optional until made required.
  await admin.page.waitForSelector('#admin-signupReason');
  if ((await admin.page.inputValue('#admin-signupReason')) !== 'optional') throw new Error('reason not optional by default');
  await admin.page.selectOption('#admin-signupReason', 'required');
  await admin.page.waitForFunction(() => document.querySelector('#admin-signupReason')?.value === 'required' && !document.querySelector('#admin-signupReason').disabled);

  // Someone signs up: the invite is optional, the reason isn't, and they only get the waiting page.
  const newbie = await register(browser, 'newbie');
  await newbie.page.waitForSelector('text=wait for an admin to approve them');
  if (await newbie.page.getAttribute('input[name="invite"]', 'required') !== null) throw new Error('invite required in request mode');
  const reasonBox = newbie.page.locator('textarea[placeholder="Tell us why you want to join Voicaw"]');
  if (await reasonBox.getAttribute('required') === null) throw new Error('reason not required');
  await newbie.page.click('button:has-text("Register")');
  await newbie.page.waitForTimeout(500);
  if (await newbie.page.$('[aria-label="Recovery code"]')) throw new Error('registered without a reason');
  await reasonBox.fill('My friends from the climbing club are here.\nI organise the Thursday sessions.');
  await shot(newbie.page, 'signup-request-form');
  await newbie.submit();
  await newbie.page.waitForSelector('text=Waiting for approval');
  if (await newbie.page.$('#dm-main')) throw new Error('pending account sees the app');
  await newbie.page.goto(`${BASE}/dm`);
  await newbie.page.waitForSelector('text=Waiting for approval');
  await shot(newbie.page, 'waiting');

  // The admin's open panel lists them without a reload; approving opens the app for them, live.
  await admin.page.waitForSelector(`.admin-list li:has-text("${newbie.username}")`, { timeout: 10000 });
  const asked = await admin.page.textContent(`.admin-list li:has-text("${newbie.username}")`);
  if (!asked.includes('climbing club') || !asked.includes('Thursday')) throw new Error('admin doesn\'t see why they want to join');
  await admin.page.locator(`.admin-list li:has-text("${newbie.username}")`).scrollIntoViewIfNeeded();
  await shot(admin.page, 'admin-request');
  await admin.page.click(`.admin-list li:has-text("${newbie.username}") button:has-text("Approve")`);
  await newbie.page.waitForSelector('#dm-main', { timeout: 15000 });
  await admin.page.waitForSelector('text=Nobody is waiting.');

  // On a phone: waiting page, then declined: logged out, back at the login page.
  const phone = await register(browser, 'phoney', { contextOptions: { ...devices['Pixel 7'] }, reason: 'Spam spam spam' });
  await shot(phone.page, 'signup-request-form-phone');
  const box = await phone.page.locator('textarea[name="reason"]').boundingBox();
  if (!box || box.x < 0 || box.x + box.width > devices['Pixel 7'].viewport.width) throw new Error('reason box off the phone\'s screen');
  await phone.submit();
  await phone.page.waitForSelector('text=Waiting for approval');
  await shot(phone.page, 'waiting-phone');
  await admin.page.waitForSelector(`.admin-list li:has-text("${phone.username}")`, { timeout: 10000 });
  await admin.page.click(`.admin-list li:has-text("${phone.username}") button:has-text("Decline")`);
  await phone.page.waitForSelector('input[placeholder="New Username"]', { timeout: 15000 });

  // The history: both requests, newest decision first, with their answers and who decided.
  const signupsPart = admin.page.locator('.admin-setting:has-text("Sign-up requests")');
  await signupsPart.locator('button:has-text("Show history")').click();
  const declinedRow = signupsPart.locator(`.admin-history li:has-text("${phone.username}")`);
  const approvedRow = signupsPart.locator(`.admin-history li:has-text("${newbie.username}")`);
  await declinedRow.waitFor();
  if (!(await declinedRow.textContent()).match(/Declined by admin\d*/)) throw new Error('declined row doesn\'t say who declined');
  if (!(await declinedRow.textContent()).includes('Spam spam spam')) throw new Error('declined row lost its reason');
  if (!(await approvedRow.textContent()).match(/Approved by admin\d*/)) throw new Error('approved row doesn\'t say who approved');
  const order = await signupsPart.locator('.admin-history li').allTextContents();
  if (order.findIndex((t) => t.includes(phone.username)) > order.findIndex((t) => t.includes(newbie.username))) throw new Error('history not newest first');
  await signupsPart.locator('.admin-history').scrollIntoViewIfNeeded();
  await shot(admin.page, 'admin-history');
  await declinedRow.locator('button:has-text("Delete")').click();
  await declinedRow.waitFor({ state: 'detached' });
  await signupsPart.locator('button:has-text("Hide history")').click();
  await admin.page.selectOption('#admin-signupReason', 'optional');
  await admin.page.waitForFunction(() => document.querySelector('#admin-signupReason')?.value === 'optional' && !document.querySelector('#admin-signupReason').disabled);

  // Invite only.
  await admin.page.selectOption('#admin-signupMode', 'invite');
  await admin.page.waitForFunction(() => document.querySelector('#admin-signupMode')?.value === 'invite' && !document.querySelector('#admin-signupMode').disabled);
  if (await admin.page.$('#admin-signupReason')) throw new Error('reason setting shown while invite only');
  await admin.page.click('button:has-text("Create invite")');
  const link = (await admin.page.textContent('.admin-invite code', { timeout: 10000 })).trim();
  if (!/\/join\/[A-Za-z0-9]+$/.test(link)) throw new Error(`odd invite link ${link}`);
  await admin.page.waitForSelector('text=Used 0 of 1');
  await shot(admin.page, 'admin-invites');

  const refused = await register(browser, 'nocode', { invite: 'notacode' });
  if (await refused.page.getAttribute('input[name="invite"]', 'required') === null) throw new Error('invite not required');
  if (await refused.page.$('textarea[name="reason"]')) throw new Error('asked why while invite only');
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
