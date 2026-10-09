// Quick reactions are the ones you use (client/src/emoji/quickReactions.js): the right-click
// menu starts with the defaults; adding someone's reaction by clicking it, and reacting from
// the quick row, count as uses, so those move to the front; the same account on a phone (a
// second login) gets them in the long-press sheet.
//   node e2e/serve.mjs &   then   node e2e/frequentreactions.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { BASE, launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

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
const quickRow = (page, sel) => page.$$eval(`${sel} img`, (els) => els.map((e) => e.alt));

async function menuOn(page, text) {
  await content(page, text).click({ button: 'right' });
  await page.waitForSelector('.context-menu');
}
async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.context-menu', { state: 'detached' });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  await openChat(b, alice.id);
  for (const text of ['first', 'second', 'third']) {
    await send(b, text);
    await waitText(b, text);
  }
  await openChat(a, bob.id);
  await waitText(a, 'third');

  await menuOn(a, 'first');
  check(JSON.stringify(await quickRow(a, '.context-menu-reactions')) === JSON.stringify(['👍', '❤️', '😂', '😮', '😢']),
    'nothing used yet: the default quick reactions');
  await closeMenu(a);

  // Bob reacts 😎 from the picker; Alice adds hers by clicking his.
  await menuOn(b, 'first');
  await b.click('.context-menu [role="menuitem"]:has-text("Add Reaction")');
  await b.fill('.emoji-picker input[type="search"]', 'sunglasses');
  await b.click('.emoji-picker-item[aria-label="Smiling Face with Sunglasses"]');
  const chip = row(a, 'first').locator('.reaction-chip:not(.reaction-add)');
  await chip.waitFor({ timeout: 10000 });
  await chip.click();
  await row(a, 'first').locator('.reaction-chip.mine').waitFor({ timeout: 10000 });

  await menuOn(a, 'second');
  check((await quickRow(a, '.context-menu-reactions'))[0] === '😎', 'clicking someone\'s reaction makes it your first quick reaction');
  // 😂 from the quick row, twice (two messages): now used most.
  await a.click('.context-menu-reaction img[alt="😂"]');
  await row(a, 'second').locator('.reaction-chip.mine').waitFor({ timeout: 10000 });
  await menuOn(a, 'third');
  await a.click('.context-menu-reaction img[alt="😂"]');
  await row(a, 'third').locator('.reaction-chip.mine').waitFor({ timeout: 10000 });

  await menuOn(a, 'first');
  const desktop = await quickRow(a, '.context-menu-reactions');
  check(JSON.stringify(desktop.slice(0, 2)) === JSON.stringify(['😂', '😎']), `reacting from the quick row counts too (${desktop.join(' ')})`);
  check(!desktop.slice(2).includes('😂'), 'and it isn\'t offered twice');
  await shot(a, '01-desktop-menu');
  await closeMenu(a);

  // Hovering a message: the first three, left of the hover menu's buttons, a line between.
  await content(a, 'second').hover();
  await a.waitForSelector('.message-menu .quick-reaction-button');
  const hover = await quickRow(a, '.message-menu .quick-reaction-button');
  check(JSON.stringify(hover) === JSON.stringify(desktop.slice(0, 3)), `hovering offers the top three (${hover.join(' ')})`);
  const order = await a.$eval('.message-menu', (menu) => [...menu.children].map((el) => el.className));
  check(order[3] === 'message-menu-separator' && order.slice(0, 3).every((c) => c.startsWith('quick-reaction-button')), 'before a separator and the other buttons');
  const pressed = await a.$$eval('.message-menu .quick-reaction-button', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  check(pressed[0] === 'true' && pressed[1] === 'false', 'the one already yours is marked');
  const bar = await a.$eval('.message-menu', (menu) => {
    const r = menu.getBoundingClientRect();
    return { h: r.height, buttons: [...menu.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height)) };
  });
  check(bar.h < 40 && new Set(bar.buttons).size <= 2, `bar keeps its height (${bar.h}px, buttons ${bar.buttons.join('/')})`);
  await shot(a, '02-hover-menu');
  await a.click('.message-menu .quick-reaction-button >> nth=2');
  await row(a, 'second').locator('.reaction-chip.mine').nth(1).waitFor({ timeout: 10000 });
  check(true, 'one click reacts');
  await content(a, 'second').hover();
  await a.click('.message-menu .quick-reaction-button[aria-pressed="true"] >> nth=1');
  await a.waitForFunction(() => document.querySelectorAll('.each-dm-message-wrapper .reaction-chip.mine').length === 3, null, { timeout: 10000 });
  check(true, 'and clicking it again takes it back');
  const theme = await a.evaluate(() => document.documentElement.dataset.theme);
  await a.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await content(a, 'second').hover();
  await shot(a, '03-hover-menu-light');
  await a.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);

  // The same account on a phone, once the usage has been saved.
  await a.waitForTimeout(3000);
  const phone = await browser.newContext(devices['Pixel 7']);
  const p = await phone.newPage();
  await p.goto(`${BASE}/`);
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.click('button:has-text("Login")');
  await p.waitForSelector('#dm-main', { timeout: 20000 });
  await openChat(p, bob.id);
  await waitText(p, 'first');
  const box = await content(p, 'first').boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await p.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForSelector('.action-sheet');
  const sheet = await quickRow(p, '.action-sheet-reactions');
  check(JSON.stringify(sheet.slice(0, 2)) === JSON.stringify(['😂', '😎']) && sheet.length === 6, `the phone's long-press sheet has them too (${sheet.join(' ')})`);
  await shot(p, '02-phone-sheet');

  console.log('frequentreactions: ok');
} catch (err) {
  console.error('frequentreactions: FAILED', err.message.split('\n')[0]);
  for (const ctx of browser.contexts()) for (const [i, pg] of ctx.pages().entries()) await shot(pg, `failed-${browser.contexts().indexOf(ctx)}-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
