// The desktop hover menu (quick reactions, edit, reply, delete) never covers its own message's
// text: it sits above the message (over the end of the one before), also on a grouped message
// (no picture, one line tall) with a long line under it; the first message, where the list's
// top edge would cut it off, gets it over its top right corner instead, never below it. The menu
// stays usable (Reply from it).
//   node e2e/serve.mjs &   then   node e2e/hovermenu.mjs [screenshot dir]
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

// Hovers a message (its left end, away from the menu) and measures the menu against the
// message's text: the line boxes of every text node in its content, its name and its date.
async function hoverMeasure(page, text) {
  const r = row(page, text);
  const box = await r.boundingBox();
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await r.locator('.message-menu').waitFor();
  return r.evaluate((el) => {
    const menu = el.querySelector('.message-menu').getBoundingClientRect();
    const rects = [];
    const walker = document.createTreeWalker(el.querySelector('.dm-message'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('.message-hover-time')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      rects.push(...[...range.getClientRects()].map((b) => ({ top: b.top, bottom: b.bottom, left: b.left, right: b.right })));
    }
    const hits = rects.filter((b) => b.left < menu.right && b.right > menu.left && b.top < menu.bottom && b.bottom > menu.top);
    const view = el.closest('.message-scroller').getBoundingClientRect();
    return {
      hits: hits.length,
      lines: rects.length,
      cls: el.querySelector('.message-menu').className,
      inView: menu.top >= view.top && menu.bottom <= view.bottom,
      atTop: menu.top <= el.getBoundingClientRect().top,
    };
  });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  await a.setViewportSize({ width: 1100, height: 800 });
  await openChat(a, bob.id);
  const long = 'This line runs right across the chat so its end sits under where the hover menu used to be drawn over it, and then some more words to be sure.';
  const msgs = ['first message', 'second one', long, 'short', `${long} Again!`];
  for (const m of msgs) {
    await send(a, m);
    await content(a, m).waitFor({ timeout: 10000 });
  }
  check(await row(a, 'second one').evaluate((el) => el.classList.contains('grouped')), 'later messages are grouped (no picture)');

  for (const m of msgs.slice(1)) {
    const res = await hoverMeasure(a, m);
    check(res.lines > 0 && res.hits === 0 && res.inView, `menu over none of "${m.slice(0, 20)}…"'s text (${res.lines} line boxes, ${res.cls})`);
  }
  await shot(a, 'grouped-long');

  // The first message: the list's top edge is just above it, so the menu goes over its top corner.
  await a.evaluate(() => { document.querySelector('.message-scroller').scrollTop = 0; });
  const first = await hoverMeasure(a, 'first message');
  check(first.hits === 0 && first.inView && first.atTop, `first message's menu is in view, at its top and off its text (${first.cls})`);
  await shot(a, 'first');

  // A message scrolled flush to the list's top edge: no room above, so the menu goes over its top
  // corner, not below it.
  for (let i = 0; i < 25; i++) await send(a, `filler ${i}`);
  await content(a, 'filler 24').waitFor({ timeout: 10000 });
  await a.setViewportSize({ width: 1100, height: 450 });
  await a.waitForTimeout(300);
  await row(a, 'filler 5').evaluate((el) => {
    const scroller = el.closest('.message-scroller');
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await a.waitForTimeout(300);
  const edge = await hoverMeasure(a, 'filler 5');
  // (It may be cut off a little by the list's edge: still better than below the message.)
  check(edge.cls.includes('inside') && edge.atTop && edge.hits === 0, `message at the top edge: menu over its top corner (not below), off its text (${edge.cls})`);
  await shot(a, 'top-edge');

  // Still usable: move onto it and Reply.
  const r = row(a, 'short');
  await r.scrollIntoViewIfNeeded();
  const box = await r.boundingBox();
  await a.mouse.move(box.x + 80, box.y + box.height / 2);
  const reply = r.locator('.message-menu button:has([data-icon="reply"])');
  await reply.hover();
  await reply.click();
  await a.waitForSelector('.replying-banner, .reply-bar, [class*="replying"]', { timeout: 5000 });
  check(true, 'Reply from the menu (pointer moved onto it) works');
  console.log('hovermenu: ok');
} catch (err) {
  console.error('hovermenu: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
