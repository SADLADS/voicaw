// A message's right-click menu (desktop) and its long-press sheet (phone): quick reaction,
// Add Reaction (the picker), Reply, Edit, Pin, Copy Text, Delete (asks; Shift doesn't); not
// on someone else's for Edit/Delete; a link gets its own menu (Copy Link, Open Link) instead.
//   node e2e/serve.mjs &   then   node e2e/messagemenu.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { BASE, launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const content = (page, text) => page.locator('.dm-message-content', { hasText: exactly(text) });
const row = (page, text) => page.locator('.each-dm-message-wrapper', { has: content(page, text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });
const items = (page, sel) => page.$$eval(`${sel} [role="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));

// Right-clicks the message's text and waits for its menu.
async function menuOn(page, text) {
  await content(page, text).click({ button: 'right' });
  await page.waitForSelector('.context-menu');
}
async function pick(page, label) {
  await page.click(`.context-menu [role="menuitem"]:has-text("${label}")`);
  await page.waitForSelector('.context-menu', { state: 'detached' });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  console.log('computer');
  await openChat(bob.page, alice.id);
  await send(bob.page, 'hi from bob');
  await waitText(bob.page, 'hi from bob');
  await openChat(a, bob.id);
  await send(a, 'my own message');
  await waitText(a, 'my own message');
  await waitText(a, 'hi from bob');

  await menuOn(a, 'my own message');
  check(same(await items(a, '.context-menu'), ['Add Reaction', 'Reply', 'Edit Message', 'Pin Message', 'Copy Text', 'Delete Message']),
    'right-clicking your own message: every action');
  check(await a.locator('.context-menu-reaction').count() === 5, 'with five quick reactions on top');
  check(await row(a, 'my own message').evaluate((el) => el.classList.contains('focused')), 'the message stays highlighted while it is open');
  const box = await a.locator('.context-menu').boundingBox();
  const at = await content(a, 'my own message').boundingBox();
  check(Math.abs(box.x - (at.x + at.width / 2)) < 4, 'the menu opens at the pointer');
  await shot(a, '01-own-menu');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.context-menu', { state: 'detached' });

  await menuOn(a, 'hi from bob');
  check(same(await items(a, '.context-menu'), ['Add Reaction', 'Reply', 'Pin Message', 'Copy Text', 'Report Message']),
    `someone else's: no Edit or Delete (${await items(a, '.context-menu')})`);
  await a.click('.context-menu-reaction[aria-label="React with Thumbs Up"]');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await row(a, 'hi from bob').locator('.message-reactions button[aria-pressed="true"]').waitFor({ timeout: 10000 });
  check(true, 'a quick reaction reacts in one click');
  await row(bob.page, 'hi from bob').locator('.message-reactions button').first().waitFor({ timeout: 10000 });
  check(true, 'and the other side sees it');

  await menuOn(a, 'hi from bob');
  check(await a.locator('.context-menu-reaction[aria-label="React with Thumbs Up"]').getAttribute('aria-checked') === 'true',
    'your own reaction is marked in the row');
  await pick(a, 'Add Reaction');
  await a.waitForSelector('.reaction-picker-anchor', { state: 'attached', timeout: 10000 });
  check(true, 'Add Reaction opens the full picker');
  await shot(a, '02-picker');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.reaction-picker-anchor', { state: 'detached' });

  await menuOn(a, 'hi from bob');
  await pick(a, 'Reply');
  await a.waitForSelector('.reply-bar');
  check(await a.evaluate(() => document.activeElement?.id === 'dm-input'), 'Reply sets up a reply and focuses the box');
  await a.keyboard.type('replying via the menu');
  await a.keyboard.press('Enter');
  await waitText(a, 'replying via the menu');
  check(await row(a, 'replying via the menu').locator('.reply-snippet').count() === 1, 'the reply is sent as one');

  await menuOn(a, 'my own message');
  await pick(a, 'Edit Message');
  await a.locator('.each-dm-message-wrapper [contenteditable="true"]').waitFor();
  await a.keyboard.press('End');
  await a.keyboard.type(' (edited)');
  await a.keyboard.press('Enter');
  await waitText(a, 'my own message (edited)');
  check(true, 'Edit Message opens the inline editor');

  await menuOn(a, 'my own message (edited)');
  await pick(a, 'Pin Message');
  await row(a, 'my own message (edited)').locator('.message-pinned').waitFor({ timeout: 10000 });
  await menuOn(a, 'my own message (edited)');
  check((await items(a, '.context-menu')).includes('Unpin Message'), 'Pin Message pins it, then the menu offers Unpin');
  await a.keyboard.press('Escape');

  await menuOn(a, 'hi from bob');
  await a.click('.context-menu [role="menuitem"]:has-text("Copy Text")');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check(await a.evaluate(() => navigator.clipboard.readText()) === 'hi from bob', 'Copy Text copies it and closes the menu');

  // A link gets its own menu instead (PageMenus), not the message's.
  await send(a, 'see https://example.com/page');
  const link = row(a, 'see https://example.com/page').locator('a[href]');
  await link.waitFor({ timeout: 20000 });
  await link.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  const linkItems = await a.$$eval('.context-menu [role^="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));
  check(JSON.stringify(linkItems) === JSON.stringify(['Copy Link', 'Open Link']), `a link has its own menu: ${linkItems.join(', ')}`);
  await a.keyboard.press('Escape');
  await a.waitForSelector('.context-menu', { state: 'detached' });

  await menuOn(a, 'replying via the menu');
  await pick(a, 'Delete Message');
  await a.waitForSelector('text=Are you sure you want to delete this message?');
  await shot(a, '03-delete-asks');
  await a.click('.btn-danger:has-text("Delete")');
  await row(a, 'replying via the menu').waitFor({ state: 'detached', timeout: 10000 });
  check(true, 'Delete Message asks first, then deletes');

  await menuOn(a, 'see https://example.com/page');
  await a.keyboard.down('Shift');
  await a.click('.context-menu [role="menuitem"]:has-text("Delete Message")');
  await a.keyboard.up('Shift');
  await row(a, 'see https://example.com/page').waitFor({ state: 'detached', timeout: 10000 });
  check(await a.locator('text=Are you sure you want to delete this message?').count() === 0, 'Shift+Delete Message skips the question');

  console.log('phone');
  const c = carol.page;
  await openChat(c, alice.id);
  // On a phone Enter is a new line: tap Send.
  await c.tap('#dm-input');
  await c.keyboard.type('from my phone');
  await c.tap('button:has-text("Send")');
  await waitText(c, 'from my phone');
  const cbox = await content(c, 'from my phone').boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const point = { x: cbox.x + 20, y: cbox.y + cbox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await c.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.action-sheet');
  const sheet = await c.$$eval('.action-sheet-items button', (els) => els.map((e) => e.textContent.trim()));
  check(same(sheet, ['Reply', 'Edit', 'Pin message', 'Copy text', 'Delete']), `holding a message opens the same actions (${sheet.join(', ')})`);
  check(await c.locator('.action-sheet-reaction').count() === 7, 'with quick reactions and +');
  check(await c.locator('.context-menu').count() === 0, 'and not the desktop menu');
  await shot(c, '04-phone-sheet');

  console.log('messagemenu: ok');
} catch (err) {
  console.error('messagemenu: FAILED', err.message.split('\n')[0]);
  for (const ctx of browser.contexts()) for (const [i, p] of ctx.pages().entries()) await shot(p, `failed-${browser.contexts().indexOf(ctx)}-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
