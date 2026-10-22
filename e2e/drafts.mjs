// Unsent messages: what's typed in a DM or channel (an attachment too) is still there after going elsewhere in the
// app (another DM, Settings, a guild) and back, without telling anyone you're typing; a
// reload (like closing the tab) forgets it. Desktop + phone.
//   node e2e/serve.mjs &   then   node e2e/drafts.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const boxText = (page) => page.$eval('#dm-input', (el) => el.innerText.trim());
const typeInBox = async (page, text) => {
  await page.click('#dm-input');
  await page.keyboard.type(text);
};
const clickDm = async (page, name) => {
  await page.click(`.dm-user:has-text("${name}")`);
  await page.waitForSelector(`#dm-input[aria-label="Message ${name}"]`);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  // In each other's DM list (it shows friends and conversations).
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  await openChat(b, alice.id);

  // DM to DM.
  await openChat(a, bob.id);
  await typeInBox(a, 'half a thought for bob');
  await clickDm(a, carol.name);
  check(await boxText(a) === '', "Carol's box is empty (Bob's draft didn't follow)");
  await typeInBox(a, 'and one for carol');
  await clickDm(a, bob.name);
  check(await boxText(a) === 'half a thought for bob', "back with Bob: his draft is there");
  await clickDm(a, carol.name);
  check(await boxText(a) === 'and one for carol', "back with Carol: hers is there");

  // Settings (the chat goes away entirely) and back.
  await clickDm(a, bob.name);
  await a.click('a[aria-label="Settings"]');
  await a.waitForSelector('#dm-input', { state: 'detached' });
  await a.click('a[aria-label="Direct Messages"]');
  await clickDm(a, bob.name);
  check(await boxText(a) === 'half a thought for bob', 'after Settings: the draft is back');
  if (shots) await a.screenshot({ path: `${shots}/drafts-dm.png` });

  // An attachment comes back with the text (after Settings and another DM), and sends.
  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'kept.png', mimeType: 'image/png', buffer: PNG });
  await a.waitForSelector('.attachment-draft');
  await a.click('a[aria-label="Settings"]');
  await a.waitForSelector('#dm-input', { state: 'detached' });
  await a.click('a[aria-label="Direct Messages"]');
  await clickDm(a, carol.name);
  check(!(await a.$('.attachment-draft')), "Carol's chat has no attachment");
  await clickDm(a, bob.name);
  await a.waitForSelector('.attachment-draft', { timeout: 5000 });
  check(await a.$eval('#dm-input', (el) => el.querySelector('.editor-attachment')?.textContent ?? '') === '📎 kept.png'
    && (await boxText(a)).startsWith('half a thought for bob'), 'back with Bob: the text and the attachment are in the box');
  check(await a.$eval('.attachment-draft', (el) => el.title) === 'kept.png', 'and in the tray, with its preview');
  if (shots) await a.screenshot({ path: `${shots}/drafts-attachment.png` });

  // Coming back doesn't count as typing: let Alice's real typing time out on Bob's side first.
  await b.waitForSelector('.typing-indicator .typing-dots', { state: 'detached', timeout: 15000 });
  await clickDm(a, carol.name);
  await clickDm(a, bob.name);
  await a.waitForTimeout(2000);
  check(!(await b.$('.typing-indicator .typing-dots')), "Bob doesn't see Alice typing when her draft comes back");

  // Sending forgets it.
  await a.click('#dm-input');
  await a.keyboard.press('Enter');
  await b.waitForSelector('text=half a thought for bob', { timeout: 10000 });
  await b.waitForSelector('.dm-message-content img[alt="kept.png"]', { timeout: 15000 });
  check(true, 'Bob gets the message with the attachment');
  await clickDm(a, carol.name);
  await clickDm(a, bob.name);
  check(await boxText(a) === '', 'once sent, the draft is gone');

  // A guild channel, and back from the DMs.
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Draft Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.waitForSelector('#dm-input');
  await typeInBox(a, 'a channel draft with :smile: and **bold**');
  await a.click('a[aria-label="Direct Messages"]');
  await clickDm(a, carol.name);
  check(await boxText(a) === 'and one for carol', "Carol's draft is still there");
  await a.click('.rail-guild[aria-label="Draft Guild"]');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.waitForSelector('#dm-input');
  check(await boxText(a) === 'a channel draft with 😄 and **bold**', `the channel's draft is back (${await boxText(a)})`);
  if (shots) await a.screenshot({ path: `${shots}/drafts-guild.png` });

  // A reload is a new page: the drafts are gone (never stored).
  await a.reload();
  await a.waitForSelector('#dm-input');
  check(await boxText(a) === '', 'after a reload the channel draft is gone');

  // Phone: chat -> list -> another chat -> back.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  const p = phone.page;
  await makeFriends(phone, bob, carol);
  await openChat(p, bob.id);
  await p.tap('#dm-input');
  await p.keyboard.type('typed on the phone');
  await p.goBack();
  await p.waitForSelector(`.dm-user:has-text("${carol.name}")`);
  await p.tap(`.dm-user:has-text("${carol.name}")`);
  await p.waitForSelector(`#dm-input[aria-label="Message ${carol.name}"]`);
  check(await boxText(p) === '', "phone: Carol's box is empty");
  await p.goBack();
  await p.tap(`.dm-user:has-text("${bob.name}")`);
  await p.waitForSelector(`#dm-input[aria-label="Message ${bob.name}"]`);
  check(await boxText(p) === 'typed on the phone', 'phone: back with Bob, the draft is there');
  if (shots) await p.screenshot({ path: `${shots}/drafts-phone.png` });
} catch (err) {
  console.error('drafts: FAILED', err.message.split('\n')[0]);
  failed = true;
} finally {
  await browser.close();
}
console.log(failed ? 'drafts e2e: FAILED' : 'drafts e2e: ok');
process.exitCode = failed ? 1 : 0;
