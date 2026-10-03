// The hover menu after Shift+deleting a message from it: the next message slides under the
// still pointer and gets the menu at once (no mouse move needed); deleting the last one leaves
// no menu anywhere; another message deleted live above the pointer moves the menu with the rows.
//   node e2e/serve.mjs &   then   node e2e/hoverdelete.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const content = (page, text) => page.locator('.dm-message-content', { hasText: exactly(text) });
const row = (page, text) => page.locator('.each-dm-message-wrapper', { has: content(page, text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });
// The texts of the rows showing the hover menu, after the next paint.
async function menuRows(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  })));
  return page.$$eval('.each-dm-message-wrapper:has(.message-menu) .dm-message-content', (els) => els.map((e) => e.textContent));
}
const trash = (page, text) => row(page, text).locator('.message-menu button:has(svg[data-icon="trash"])');

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  await openChat(bob.page, alice.id);
  await openChat(a, bob.id);
  for (const text of ['one', 'two', 'three', 'four']) {
    await send(a, text);
    await waitText(a, text);
  }
  await waitText(bob.page, 'four');

  await row(a, 'two').hover();
  check(JSON.stringify(await menuRows(a)) === '["two"]', 'hovering a message shows its menu');
  const button = await trash(a, 'two').boundingBox();
  await a.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await a.keyboard.down('Shift');
  await a.mouse.down();
  await a.mouse.up();
  await a.keyboard.up('Shift');
  await content(a, 'two').waitFor({ state: 'detached', timeout: 10000 });
  check(await a.locator('.modal, [role="dialog"]').count() === 0, 'Shift+delete from the hover menu asks nothing');
  check(JSON.stringify(await menuRows(a)) === '["three"]', 'the next message, now under the still pointer, has the menu');
  await shot(a, '01-after-delete');

  // Its Delete is where the pointer is: Shift+click again without moving.
  await a.keyboard.down('Shift');
  await a.mouse.down();
  await a.mouse.up();
  await a.keyboard.up('Shift');
  await content(a, 'three').waitFor({ state: 'detached', timeout: 10000 });
  check(JSON.stringify(await menuRows(a)) === '["four"]', 'and again: deleting in a row without moving the mouse');

  await a.keyboard.down('Shift');
  await a.mouse.down();
  await a.mouse.up();
  await a.keyboard.up('Shift');
  await content(a, 'four').waitFor({ state: 'detached', timeout: 10000 });
  const left = await menuRows(a);
  check(left.length === 0 || JSON.stringify(left) === '["one"]' && await row(a, 'one').evaluate((el) => el.matches(':hover')),
    'deleting the last one: no menu on a row the pointer is not over');

  // Someone else's message deleted above the pointer: the rows move up under it.
  await send(bob.page, 'from bob');
  await waitText(a, 'from bob');
  await send(a, 'five');
  await waitText(a, 'five');
  await send(a, 'six');
  await waitText(a, 'six');
  await row(a, 'five').hover();
  check(JSON.stringify(await menuRows(a)) === '["five"]', 'hovering "five"');
  await row(bob.page, 'from bob').hover();
  const bobTrash = await trash(bob.page, 'from bob').boundingBox();
  await bob.page.mouse.move(bobTrash.x + bobTrash.width / 2, bobTrash.y + bobTrash.height / 2);
  await bob.page.keyboard.down('Shift');
  await bob.page.mouse.down();
  await bob.page.mouse.up();
  await bob.page.keyboard.up('Shift');
  await content(a, 'from bob').waitFor({ state: 'detached', timeout: 10000 });
  const now = await menuRows(a);
  const hovered = await a.$$eval('.each-dm-message-wrapper:hover .dm-message-content', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(now) === JSON.stringify(hovered), `a message deleted live above: the menu is on the row under the pointer (${now})`);
  await shot(a, '02-live-delete');

  console.log('all good');
} finally {
  await browser.close();
}
