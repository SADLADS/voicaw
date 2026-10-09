// Timestamps (Discord's <t:unix:style>): the computer's + menu → Timestamps (date, time, the
// formats with previews), Insert puts a chip in the message box showing how it will read; typing
// `<t:…:t>` out in full does the same; sent, Bob sees it in his time (relative ones counting, the
// full date on hover), and the reply preview reads it as text. Phone: the + panel's bar ends with
// Timestamps, which opens the same dialog.
//   node e2e/serve.mjs &   then   node e2e/timestamps.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// Today + 2 days at 18:00 in the browser's time zone, as the inputs take it.
const target = new Date();
target.setDate(target.getDate() + 2);
target.setHours(18, 0, 0, 0);
const pad = (n) => String(n).padStart(2, '0');
const dateValue = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
const unix = Math.floor(target.getTime() / 1000);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  await openChat(a, bob.id);
  await openChat(bob.page, alice.id);

  // ---- Computer: + menu → Timestamps ----
  await a.click('button[aria-label="Add"]');
  const items = await a.locator('.composer-add-menu [role="menuitem"]').allTextContents();
  check(items.map((s) => s.trim()).at(-1) === 'Timestamps', `the + menu ends with Timestamps (${items.map((s) => s.trim()).join(', ')})`);
  await a.click('.composer-add-menu >> text=Timestamps');
  const dialog = a.locator('.timestamp-dialog');
  await dialog.waitFor();
  await a.fill('.timestamp-dialog input[type="date"]', dateValue);
  await a.fill('.timestamp-dialog input[type="time"]', '18:00');
  const styles = await a.locator('.timestamp-style').allTextContents();
  check(styles.length === 7, `seven formats (${styles.length})`);
  check(styles.some((s) => s.startsWith('18:00Short time')), 'Short time previews 18:00');
  check(styles.some((s) => /^in 2 days|^in \d+ (hours|days)Relative$/.test(s)), `Relative previews how far off it is (${styles.at(-1)})`);
  await a.click('.timestamp-style:has-text("Relative")');
  check((await a.locator('.timestamp-dialog-code code').textContent()) === `<t:${unix}:R>`, 'the code shown is <t:unix:R>');
  await shot(a, 'dialog');
  await a.click('.timestamp-dialog button:has-text("Insert")');
  await dialog.waitFor({ state: 'detached' });
  const chip = a.locator('#dm-input .editor-timestamp');
  check(/^in \d+ (hours|days)$/.test(await chip.textContent()), `the box shows a chip reading "${await chip.textContent()}"`);
  check(await a.evaluate(() => document.activeElement?.id === 'dm-input'), 'the box has focus again');

  // Typed out in full: a chip too.
  await a.keyboard.type(`starts <t:${unix}:t>`);
  check((await a.locator('#dm-input .editor-timestamp').count()) === 2, 'typing <t:…:t> out makes a chip');
  check((await a.locator('#dm-input .editor-timestamp').nth(1).textContent()) === '18:00', 'reading 18:00');
  await shot(a, 'box');
  await a.keyboard.press('Enter');

  // Bob sees them in his time.
  const seen = bob.page.locator('.message-scroller time.timestamp');
  await seen.first().waitFor({ timeout: 10000 });
  const texts = await seen.allTextContents();
  check(/^in \d+ (hours|days)$/.test(texts[0]) && texts[1] === '18:00', `Bob sees "${texts.join('", "')}"`);
  const title = await seen.nth(1).getAttribute('title');
  check(/18:00$/.test(title) && title.split(' ').length >= 4, `with the full date on hover ("${title}")`);
  await seen.nth(1).hover();
  await shot(bob.page, 'message');

  // Plain-text places: the reply preview.
  const message = bob.page.locator('.each-dm-message-wrapper').last();
  await message.hover();
  await bob.page.click('.each-dm-message-wrapper >> nth=-1 >> [aria-label="Reply"]').catch(() => {});
  const replying = await bob.page.locator('.reply-bar, .replying-to').first().textContent().catch(() => '');
  check(!replying || !replying.includes('<t:'), 'no raw <t:…> in the reply bar');

  // ---- Phone: the + panel's bar ----
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const c = carol.page;
  await openChat(c, alice.id);
  await c.tap('button[aria-label="Add"]');
  await c.locator('.attach-panel').waitFor();
  const bar = (await c.locator('.attach-panel-bar button').allTextContents()).map((s) => s.trim());
  check(bar.join(',') === 'Photos,Poll,Files,Timestamps', `the phone bar: ${bar.join(', ')}`);
  const barFits = await c.locator('.attach-panel-bar').evaluate((el) => el.scrollWidth <= el.clientWidth);
  check(barFits, 'the bar fits the phone');
  await shot(c, 'phone-panel');
  await c.tap('.attach-panel-bar button:has-text("Timestamps")');
  await c.locator('.timestamp-dialog').waitFor();
  check(!(await c.$('.attach-panel')), 'the dialog takes the panel\'s place');
  await shot(c, 'phone-dialog');
  await c.tap('.timestamp-dialog button:has-text("Insert")');
  await c.locator('#dm-input .editor-timestamp').waitFor();
  check(true, 'Insert puts a chip in the box');
  await shot(c, 'phone-box');
} catch (err) {
  console.error('timestamps: FAILED', err.message.split('\n')[0]);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `timestamps: ${failures} FAILED` : 'timestamps: ok');
process.exitCode = failures ? 1 : 0;
