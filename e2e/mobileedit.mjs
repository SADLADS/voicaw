// Editing a message on a phone: hold → Edit puts its text in the message box (not an inline
// editor) under an "Editing message" bar, focused; Save edits it (no new message) and empties
// the box; the bar's × stops editing, empties the box and keeps it focused (the keyboard stays
// up). A computer still edits inline.
//   node e2e/serve.mjs &   then   node e2e/mobileedit.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const content = (page, text) => page.locator('.dm-message-content', { hasText: exactly(text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });
const boxText = (page) => page.$eval('#dm-input', (el) => el.innerText.trim());
const boxFocused = (page) => page.evaluate(() => document.getElementById('dm-input')?.contains(document.activeElement));
const inlineEditors = (page) => page.locator('.each-dm-message-wrapper [contenteditable="true"]').count();

// Holds a finger on the message, then taps the sheet's action.
async function holdAndPick(page, cdp, text, label) {
  await page.waitForTimeout(500); // the list settles (a send or edit just re-laid it out)
  const box = await content(page, text).boundingBox();
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('.action-sheet');
  await page.tap(`.action-sheet-items button:has-text("${label}")`);
  await page.waitForSelector('.action-sheet', { state: 'detached' });
}

async function phoneSend(page, text) {
  await page.tap('#dm-input');
  await page.keyboard.type(text);
  await page.tap('button:has-text("Send")');
  await waitText(page, text);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', devices['Pixel 7']);
  const bob = await signUp(browser, 'bob');
  const p = alice.page;
  const cdp = await p.context().newCDPSession(p);

  console.log('phone');
  await openChat(bob.page, alice.id);
  await openChat(p, bob.id);
  await phoneSend(p, 'first try');
  await phoneSend(p, 'second one');
  const rows = await p.locator('.each-dm-message-wrapper').count();

  await holdAndPick(p, cdp, 'first try', 'Edit');
  await p.locator('.reply-bar', { hasText: 'Editing message' }).waitFor();
  check(await inlineEditors(p) === 0, 'Edit opens no inline editor');
  check(await boxText(p) === 'first try', 'the message box holds the message');
  check(await boxFocused(p), 'and is focused (keyboard comes up)');
  check(await p.locator('.attach-button').count() === 0, 'no + while editing');
  check(await p.locator('.send-button').innerText() === 'Save', 'Send reads Save');
  check(await content(p, 'first try').evaluate((el) => el.closest('.each-dm-message-wrapper').classList.contains('focused')),
    'the message being edited is highlighted');
  await shot(p, '1-phone-editing');

  await p.keyboard.press('End');
  await p.keyboard.type(' (fixed)');
  await p.tap('button:has-text("Save")');
  await waitText(p, 'first try (fixed)');
  await waitText(bob.page, 'first try (fixed)');
  check(await p.locator('.each-dm-message-wrapper').count() === rows, 'Save edits it, no new message (Bob sees the edit)');
  check(await p.locator('.reply-bar', { hasText: 'Editing message' }).count() === 0, 'the bar goes');
  check(await boxText(p) === '', 'the box is emptied');
  check(await p.locator('.send-button').innerText() === 'Send', 'Send is back');

  await holdAndPick(p, cdp, 'second one', 'Edit');
  await p.locator('.reply-bar', { hasText: 'Editing message' }).waitFor();
  await p.keyboard.type(' changed my mind');
  await p.tap('.reply-bar button[aria-label="Stop editing"]');
  await p.locator('.reply-bar', { hasText: 'Editing message' }).waitFor({ state: 'detached' });
  check(await boxText(p) === '', '× empties the box');
  check(await boxFocused(p), 'and keeps it focused (keyboard stays up)');
  check(await content(p, 'second one').count() === 1, 'the message is unchanged');
  await p.keyboard.type('a new message');
  await p.tap('button:has-text("Send")');
  await waitText(p, 'a new message');
  check(true, 'the box sends normally after');
  await shot(p, '2-phone-after-cancel');

  console.log('computer');
  const b = bob.page;
  await send(b, 'from the computer');
  await waitText(b, 'from the computer');
  await content(b, 'from the computer').click({ button: 'right' });
  await b.click('.context-menu [role="menuitem"]:has-text("Edit Message")');
  await b.locator('.each-dm-message-wrapper [contenteditable="true"]').waitFor();
  check(await b.locator('.reply-bar', { hasText: 'Editing message' }).count() === 0, 'a computer still edits inline');

  console.log('mobileedit: ok');
} catch (err) {
  console.error('mobileedit: FAILED', err.message.split('\n')[0]);
  for (const ctx of browser.contexts()) for (const [i, pg] of ctx.pages().entries()) await shot(pg, `failed-${browser.contexts().indexOf(ctx)}-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
