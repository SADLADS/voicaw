// Emoji usage follows the account (client/src/emoji/emojiUsage.js): emoji picked and the skin
// tone chosen on one device show in Frequently Used and the picker on another device of the
// same account (a second browser context logging in), also live while it's open; the server
// holds only ciphertext; another account doesn't see them.
//   node e2e/serve.mjs &   then   node e2e/emojiusage.mjs [screenshot dir]
import { launchChrome, signUp, openChat, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

async function openPicker(page) {
  await page.click('button[aria-label="Emoji"]');
  await page.waitForSelector('.emoji-picker .emoji-sprite');
}

async function closePicker(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.emoji-picker', { state: 'detached' });
}

// The labels in Frequently Used, in order ([] when it isn't shown).
const frequent = (page) => page.$$eval('.emoji-picker [data-section="frequent"] .emoji-picker-item', (items) => items.map((b) => b.getAttribute('aria-label')));

async function pick(page, label) {
  await openPicker(page);
  await page.fill('.emoji-picker input[type="search"]', label.split(' ')[0].toLowerCase());
  await page.click(`.emoji-picker-item[aria-label="${label}"]`);
}

async function logIn(browser, username, password) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${username} 2] page error:`, e.message));
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="Username"]', username);
  await page.fill('input[placeholder="Password"]', password);
  await page.click('button:has-text("Login")');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  return page;
}

const savedUsage = (page) => page.evaluate(async () => {
  const res = await fetch('/api/emoji-usage', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  return res.json();
});

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await openChat(alice.page, bob.id);

  // Device 1: two emoji (one twice) and a skin tone.
  await pick(alice.page, 'Party Popper');
  await pick(alice.page, 'Party Popper');
  await pick(alice.page, 'Pizza');
  await openPicker(alice.page);
  check(JSON.stringify(await frequent(alice.page)) === JSON.stringify(['Party Popper', 'Pizza']), 'device 1: Frequently Used at once');
  await alice.page.click('.emoji-picker-tone-toggle');
  await alice.page.click('[aria-label="Skin tone 3"]');
  await closePicker(alice.page);
  await alice.page.waitForFunction(async () => {
    const res = await fetch('/api/emoji-usage', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).version > 0;
  }, null, { timeout: 10000, polling: 500 });
  await alice.page.waitForTimeout(2500); // the tone's save, after the burst's
  const saved = await savedUsage(alice.page);
  check(/^v1\.[A-Za-z0-9+/]+=*$/.test(saved.emojiUsage) && !/tada|pizza/i.test(saved.emojiUsage), 'the server holds only a v1. envelope');
  check(await alice.page.evaluate(() => localStorage.getItem('emojiFrequent') === null && localStorage.getItem('emojiSkinTone') === null), 'nothing kept per device');

  // Device 2: the same account logs in elsewhere.
  const second = await logIn(browser, alice.name, alice.password);
  await openChat(second, bob.id);
  await openPicker(second);
  check(JSON.stringify(await frequent(second)) === JSON.stringify(['Party Popper', 'Pizza']), 'device 2: the same Frequently Used');
  const thumbs = await second.$eval('.emoji-picker-item[aria-label="Thumbs Up"] .emoji', (el) => [...el.classList].join(' '));
  check(thumbs.includes('tone3'), 'device 2: the same skin tone');
  await shot(second, 'device2-picker');
  await closePicker(second);

  // Live: device 1 uses another emoji three times while device 2 is open.
  for (let i = 0; i < 3; i += 1) await pick(alice.page, 'Red Heart');
  await second.waitForTimeout(3500);
  await openPicker(second);
  check((await frequent(second))[0] === 'Red Heart', 'device 2: device 1\'s new emoji arrives live');
  await closePicker(second);

  // Another account: its own (empty) usage.
  await openChat(bob.page, alice.id);
  await openPicker(bob.page);
  check((await frequent(bob.page)).length === 0, "another account doesn't see alice's");
  await shot(bob.page, 'other-account');
} catch (err) {
  console.error('emojiusage: FAILED', err.message.split('\n')[0]);
  failed = true;
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
else console.log('emojiusage: ok');
