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
