// Phone emoji panel (hooks/useSheetDrag.js): swipe up for full screen, down to go back, the grid
// scrolls once full screen, the chat doesn't jump, the handle toggles too.
//   node e2e/serve.mjs &   then   node e2e/pickerswipe.mjs [screenshot dir]
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

// A one-finger drag through CDP touch events (as in panes.mjs).
async function drag(page, { x, y, dx = 0, dy, steps = 10, ms = 16, hold = false }) {
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

const picker = (page) => page.$eval('.emoji-picker', (el) => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), height: Math.round(r.height), classes: el.className };
});
const settled = (page) => page.waitForFunction(
  () => !document.querySelector('.emoji-picker.sheet-dragging, .emoji-picker.sheet-settling'), null, { timeout: 3000 });
const lastMessageTop = (page) => page.$$eval('.message-content, [class*="message-text"]', (els) => Math.round(els.at(-1)?.getBoundingClientRect().top ?? -1));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 15; i++) await send(alice.page, `message number ${i}`);

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 15');
  const { height } = page.viewportSize();

  await page.getByRole('button', { name: 'Emoji' }).tap();
  await page.waitForSelector('.emoji-picker.docked .emoji-picker-grid');
  const docked = await picker(page);
  check(docked.height > 100 && docked.top + docked.height >= height - 1, `docked at the bottom (${docked.height}px)`);
  await shot(page, '1-docked');

  // A slow drag up from the handle, held mid-way.
  const msgBefore = await lastMessageTop(page);
  const lift = await drag(page, { x: 200, y: docked.top + 7, dy: -200, steps: 12, ms: 30, hold: true });
  const mid = await picker(page);
  check(mid.classes.includes('sheet-dragging') && Math.abs(mid.height - (docked.height + 200)) < 4, `follows the finger (${mid.height}px)`);
  check(await lastMessageTop(page) === msgBefore, 'the chat above doesn\'t jump while dragging');
  await shot(page, '2-mid-drag');
  await page.waitForTimeout(150);
  await lift();
  await settled(page);
  const full = await picker(page);
  check(full.classes.includes('expanded') && full.top === 0 && full.height === height, `a long drag up goes full screen (${full.top}, ${full.height})`);
  await shot(page, '3-full');

  // Full screen, the grid scrolls (an upward swipe on it doesn't do anything else).
  await drag(page, { x: 200, y: height * 0.7, dy: -300, steps: 10 });
  await page.waitForTimeout(500);
  const scrolled = await page.$eval('.emoji-picker-scroll', (el) => el.scrollTop);
  check(scrolled > 0 && (await picker(page)).classes.includes('expanded'), `the grid scrolls when full screen (${scrolled})`);

  // A downward swipe on the grid while scrolled scrolls back, not shrinking.
  await drag(page, { x: 200, y: height * 0.4, dy: 150, steps: 10 });
  await page.waitForTimeout(500);
  check((await picker(page)).classes.includes('expanded'), 'swiping down mid-grid scrolls rather than shrinking');

  // A flick down on the top bar shrinks it back.
  await drag(page, { x: 200, y: 30, dy: 120, steps: 4, ms: 8 });
  await settled(page);
  const back = await picker(page);
  check(!back.classes.includes('expanded') && back.height === docked.height && back.top === docked.top, `a flick down goes back to docked (${back.height}px)`);
  check(await lastMessageTop(page) === msgBefore, 'chat where it was');
  await shot(page, '4-back');

  // A short slow drag up goes back.
  const lift2 = await drag(page, { x: 200, y: docked.top + 100, dy: -40, steps: 8, ms: 30, hold: true });
  await page.waitForTimeout(150);
  await lift2();
  await settled(page);
  check(!(await picker(page)).classes.includes('expanded'), 'a short slow drag up stays docked');

  // A flick up on the grid expands.
  await drag(page, { x: 200, y: docked.top + 150, dy: -80, steps: 4, ms: 8 });
  await settled(page);
  check((await picker(page)).classes.includes('expanded'), 'a flick up on the grid goes full screen');

  // Grid at the top: a swipe down on it shrinks.
  await page.$eval('.emoji-picker-scroll', (el) => { el.scrollTop = 0; });
  await drag(page, { x: 200, y: height * 0.5, dy: 200, steps: 10 });
  await settled(page);
  check(!(await picker(page)).classes.includes('expanded'), 'swipe down on the grid at its top goes back');

  // Handle tap, and picking an emoji full screen still inserts it.
  await page.getByRole('button', { name: 'Expand picker' }).tap();
  check((await picker(page)).classes.includes('expanded'), 'tapping the handle goes full screen');
  await page.locator('.emoji-picker-item').first().tap();
  const text = await page.$eval('#dm-input', (el) => el.textContent);
  check(text.length > 0, `tapping an emoji full screen inserts it (${text})`);
  await page.getByRole('button', { name: 'Shrink picker' }).tap();
  check(!(await picker(page)).classes.includes('expanded'), 'tapping it again goes back');

  // Searching from full screen, then back.
  await page.getByRole('button', { name: 'Expand picker' }).tap();
  await page.getByRole('searchbox', { name: 'Search emoji' }).tap();
  await page.waitForSelector('.emoji-picker.searching');
  await page.keyboard.type('pizza');
  await shot(page, '5-search-full');
  await page.getByRole('button', { name: 'Close search' }).tap();
  const after = await picker(page);
  check(after.classes.includes('expanded') && after.top === 0, 'after a search it is still full screen');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
