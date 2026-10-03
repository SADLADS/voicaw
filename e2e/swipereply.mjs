// Swipe to reply (hooks/useSwipeToReply.js), phone: a message swiped left follows the finger
// with the reply arrow, far enough sets the reply (reply bar, message box focused), a short
// one springs back, rightward still opens the list, scrolling is untouched, no long press.
//   node e2e/serve.mjs &   then   node e2e/swipereply.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// A one-finger drag through CDP touch events (as in panes.mjs); `hold`: returns the lift.
async function drag(page, { x, y, dx, dy = 0, steps = 10, ms = 16, hold = false }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
  });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y + (dy * i) / steps);
    await new Promise((r) => setTimeout(r, ms));
  }
  const lift = async () => { await touch('touchEnd'); await cdp.detach(); };
  if (hold) return lift;
  await lift();
  return null;
}

const rowOf = (page, text) => page.locator('.each-dm-message-wrapper', { hasText: text }).last();
async function middleOf(page, text) {
  const box = await rowOf(page, text).boundingBox();
  return { x: box.x + box.width * 0.6, y: box.y + box.height / 2 };
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 30; i++) await send(alice.page, `message number ${i}\nsecond line`);

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 30');
  await page.waitForTimeout(500);
  const { width, height } = page.viewportSize();

  // Mid-swipe: the message follows the finger and the arrow shows, filled in once far enough.
  let at = await middleOf(page, 'message number 29');
  const lift = await drag(page, { ...at, dx: -140, steps: 14, ms: 20, hold: true });
  const mid = await rowOf(page, 'message number 29').evaluate((row) => ({
    transform: row.style.transform,
    armed: row.dataset.swipe === 'armed',
    zIndex: getComputedStyle(row).zIndex,
    iconOpacity: getComputedStyle(row.querySelector('.swipe-reply-icon')).opacity,
    iconRight: row.querySelector('.swipe-reply-icon').getBoundingClientRect().right,
  }));
  check(/translate3d\(-\d/.test(mid.transform), `the message follows the finger (${mid.transform})`);
  check(mid.armed && mid.iconOpacity === '1', 'the reply arrow shows, filled in');
  check(mid.iconRight <= width, 'the arrow is on screen');
  check(mid.zIndex === '1', 'the row is over its neighbours (the arrow isn\'t cut off)');
  check(await page.locator('.action-sheet').count() === 0, 'no long press sheet while swiping');
  await shot(page, '1-mid-swipe');
  await lift();
  await page.waitForSelector('.reply-bar');
  check((await page.locator('.reply-bar').innerText()).includes('Replying to'), 'letting go sets the reply');
  check(await page.evaluate(() => document.activeElement?.id === 'dm-input'), 'the message box is focused');
  await page.waitForTimeout(400);
  check(await rowOf(page, 'message number 29').evaluate((row) => row.style.transform === '' && !row.dataset.swipe),
    'the message springs back');
  await shot(page, '2-replying');

  await page.keyboard.type('a swiped reply');
  await page.tap('.send-button'); // Enter is a new line on a phone
  const reply = rowOf(page, 'a swiped reply');
  await reply.waitFor();
  check((await reply.locator('.reply-snippet').innerText()).includes('message number 29'), 'the sent reply quotes the message');
  await page.evaluate(() => document.activeElement?.blur?.()); // keyboard down
  await page.waitForTimeout(400);

  // A short swipe doesn't reply.
  at = await middleOf(page, 'message number 28');
  await drag(page, { ...at, dx: -40, steps: 6 });
  await page.waitForTimeout(300);
  check(await page.locator('.reply-bar').count() === 0, 'a short swipe springs back without replying');

  // Scrolling the messages (a bit diagonally, leftwards) scrolls and doesn't reply.
  const before = await page.$eval('.message-scroller', (el) => el.scrollTop);
  at = await middleOf(page, 'message number 26');
  await drag(page, { ...at, dx: -30, dy: 200, steps: 12 });
  await page.waitForTimeout(400);
  check(await page.$eval('.message-scroller', (el) => el.scrollTop) !== before, 'a mostly vertical swipe scrolls');
  check(await page.locator('.reply-bar').count() === 0, 'and sets no reply');

  // Rightwards is still the panes' swipe: back to the list.
  await drag(page, { x: 40, y: height * 0.5, dx: width * 0.4, steps: 4, ms: 8 });
  await page.waitForFunction(() => document.querySelector('.main-wrapper.pane-list:not(.panes-moving)'), null, { timeout: 3000 });
  check(await page.locator('.reply-bar').count() === 0, 'swiping right opens the list, no reply');

  // Desktop has none of it.
  check(await alice.page.locator('.swipe-reply-icon').count() === 0, 'no swipe arrow on a computer');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
