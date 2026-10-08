// Blocking, reporting and suspending: Alice blocks Bob from his profile (his messages collapse,
// Show opens them, he can't DM her, her DM with him is closed), reports his guild message from
// its menu, and reports a DM sharing its text; the admin sees both in Settings → Reports,
// suspends Bob, whose phone is logged out at once and told why on logging in; then lifts it.
//   node e2e/serve.mjs &   then   node e2e/moderation.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, path, body]);

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;

  const guild = (await api(a, 'POST', '/guilds', { name: 'Hangout' })).body;
  const channel = guild.channels[0];
  const invite = (await api(a, 'POST', `/guilds/${guild.id}/invites`, {})).body;
  await api(b, 'POST', `/invites/${invite.code}`);
  await api(b, 'POST', `/channels/${channel.id}/messages`, { content: 'buy my pills, cheap' });

  // Alice blocks Bob from his name on his message (its right-click menu).
  await a.goto(`${BASE}/guild/${guild.id}/${channel.id}`);
  await a.waitForSelector('text=buy my pills, cheap');
  await a.click('.message-author:has-text("bob")', { button: 'right' });
  await a.click('.context-menu >> text=Block');
  await a.click('.vc-dialog button:has-text("Block")');
  await a.waitForSelector('.blocked-message:has-text("Blocked message")');
  await a.click('.member-row:has-text("bob")', { button: 'right' });
  check(await a.isVisible('.context-menu >> text=Unblock'), 'his menu now offers Unblock');
  await a.keyboard.press('Escape');
  check(!(await a.isVisible('text=buy my pills, cheap')), "Bob's message is collapsed for Alice");
  await shot(a, '1-collapsed');
  await a.click('.blocked-message button:has-text("Show")');
  check(await a.isVisible('text=buy my pills, cheap'), 'Show opens it');

  // ...and reports it from its menu.
  await a.click('.each-dm-message-wrapper:has-text("buy my pills")', { button: 'right' });
  await a.click('[role="menuitem"]:has-text("Report Message")');
  await a.check('label:has-text("Spam or scams") input');
  check(!(await a.isVisible('text=Let moderators see this message')), 'a guild message has nothing to share');
  await shot(a, '2-report-dialog');
  await a.click('button:has-text("Send report")');
  await a.waitForSelector('text=Thanks for telling us');
  await a.click('.vc-dialog button:has-text("Done")');
  check(true, 'reported the guild message');

  // Blocked: Bob can't DM Alice, and her DM with him is closed.
  const dm = await api(b, 'POST', '/dm-send', { recipient_id: alice.id, content: `v1.${'A'.repeat(40)}` });
  check(dm.status === 403 && !/block/i.test(dm.body?.error ?? ''), `Bob's DM isn't delivered, and he isn't told why (${dm.body?.error})`);
  await openChat(a, bob.id).catch(() => a.goto(`${BASE}/dm/${bob.id}`));
  await a.waitForSelector("text=You've blocked");
  check(!(await a.isVisible(`button[aria-label="Call ${bob.name}"]`)), 'no call button');
  await shot(a, '3-dm-closed');
  await a.click('button.chat-unblock-button');
  await a.waitForSelector('#dm-input');
  check(true, 'Unblock opens the DM again');

  // A DM report, sharing its text (the server can't read it otherwise).
  await openChat(b, alice.id);
  // A phone: Enter is a new line there, so the send button.
  await b.click('#dm-input');
  await b.keyboard.type('you are the worst');
  await b.tap('.send-button');
  await a.waitForSelector('text=you are the worst');
  await a.click('.each-dm-message-wrapper:has-text("you are the worst")', { button: 'right' });
  await a.click('[role="menuitem"]:has-text("Report Message")');
  await a.check('label:has-text("Harassment or bullying") input');
  check(!(await a.isChecked('label:has-text("Let moderators see this message") input')), 'sharing an encrypted message is off by default');
  await a.check('label:has-text("Let moderators see this message") input');
  await a.click('button:has-text("Send report")');
  await a.waitForSelector('text=Thanks for telling us');
  await a.click('.vc-dialog button:has-text("Done")');

  // The admin sees both and suspends Bob.
  const m = admin.page;
  await m.goto(`${BASE}/settings#reports`);
  await m.waitForSelector('.admin-report');
  const reports = await m.$$eval('.admin-report', (els) => els.map((el) => el.textContent));
  check(reports.some((r) => r.includes('buy my pills, cheap') && r.includes('Spam')), 'the guild report shows the message as it was');
  check(reports.some((r) => r.includes('you are the worst') && r.includes('As shared by the reporter')), 'the DM report shows the shared text, marked as shared');
  if (dir) await m.locator('.admin-reports').screenshot({ path: `${dir}/4-admin-reports.png` });
  await m.locator('.admin-report', { hasText: bob.name }).first().locator('button:has-text("Suspend")').click();
  await m.fill('.admin-suspend-reason textarea', 'Spamming');
  await m.click('.vc-dialog button:has-text("Suspend")');
  await m.waitForSelector('.admin-suspended-list li');
  check(true, 'Bob is suspended');

  await b.waitForSelector('input[placeholder="Username"]', { timeout: 15000 });
  check(await b.isVisible('text=This account has been suspended'), 'his open app logs out and says why');
  await shot(b, '5-phone-suspended');
  await b.fill('input[placeholder="Username"]', bob.name);
  await b.fill('input[placeholder="Password"]', bob.password);
  await b.press('input[placeholder="Password"]', 'Enter');
  await b.waitForSelector('text=Spamming');
  check(true, "logging in says he's suspended, with the reason");

  await m.click('.admin-suspended-list button:has-text("Lift")');
  await m.waitForSelector('text=Nobody is suspended.');
  await b.fill('input[placeholder="Password"]', bob.password);
  await b.press('input[placeholder="Password"]', 'Enter');
  await b.waitForSelector('#dm-main', { timeout: 20000 });
  check(true, 'lifted: he can log in again');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'OK');
process.exit(failures ? 1 : 0);
