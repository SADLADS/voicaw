// The guild member list on a phone (MemberList, hooks/useSwipeToClose.js): full screen over the
// whole guild page (header included), a swipe to the right drags it with the finger and closes
// it (a short one settles back), a swipe to the left does nothing (no swipe opens it either),
// and neither moves the phone panes; Back and the back arrow close it too, staying on the chat.
//   node e2e/serve.mjs &   then   node e2e/memberswipe.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const pane = (page) => page.evaluate(() => {
  const w = document.querySelector('.main-wrapper');
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'other';
});

// A finger dragged by dx; `halfway` runs with the finger still down, after half the moves.
async function drag(page, { x, y, dx, steps = 10, ms = 16, halfway }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
  });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y);
    await new Promise((r) => setTimeout(r, ms));
    if (i === steps / 2 && halfway) await halfway();
  }
  await touch('touchEnd');
  await cdp.detach();
  await page.waitForTimeout(400); // the settle (200 ms) and any slide of the panes
}

const browser = await launchChrome();
try {
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  const page = bob.page;
  const { width, height } = page.viewportSize();
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/guilds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Member Guild' }),
    });
    return res.json();
  });
  const guildId = created.id ?? created.guild?.id;
  await page.goto(`${BASE}/guild/${guildId}`);
  await page.waitForSelector('.channel-header');
  const chatPath = new URL(page.url()).pathname;

  const open = async () => {
    await page.click('button[aria-label="Show member list"]');
    await page.waitForSelector('.member-list .member-row');
  };
  const isOpen = async () => (await page.locator('.member-list').count()) > 0;

  await open();
  const box = await page.$eval('.member-list', (el) => {
    const r = el.getBoundingClientRect();
    const main = document.querySelector('.guild-main').getBoundingClientRect();
    return { r: [r.left, r.top, r.width, r.height], main: [main.left, main.top, main.width, main.height] };
  });
  check(JSON.stringify(box.r) === JSON.stringify(box.main), `covers the whole guild page, header included (${box.r} vs ${box.main})`);
  check(Math.round(box.r[2]) === width, 'full width');
  await shot(page, 'open');

  // Left: nothing moves (no swipe opens it, and replying stays the chat's).
  await drag(page, { x: width - 40, y: height * 0.5, dx: -width * 0.6 });
  check(await isOpen() && await pane(page) === 'content', 'swipe left: still open, panes untouched');

  // A short swipe right follows the finger, then settles back.
  let during = '';
  await drag(page, {
    x: 40, y: height * 0.5, dx: width * 0.2, ms: 80, // slow: no flick
    halfway: async () => { during = await page.$eval('.member-list', (el) => el.style.transform); },
  });
  check(/translate3d\(\d/.test(during), `follows the finger (${during})`);
  check(await isOpen() && await page.$eval('.member-list', (el) => el.style.transform) === '', 'short swipe right: settles back');

  // A long one closes it, showing the chat (not the channel list).
  await drag(page, {
    x: 40, y: height * 0.5, dx: width * 0.6,
    halfway: () => shot(page, 'dragging'),
  });
  check(!(await isOpen()), 'swipe right: closed');
  check(await pane(page) === 'content' && new URL(page.url()).pathname === chatPath, 'still on the chat');
  check(await page.isVisible('.channel-header'), 'the channel shows');

  // Back closes it, staying on the chat.
  await open();
  await page.goBack();
  await page.waitForTimeout(300);
  check(!(await isOpen()) && await pane(page) === 'content', 'Back: closed, still on the chat');

  // The back arrow too, and then Back goes to the channel list as usual.
  await open();
  await page.click('.member-list-back');
  await page.waitForTimeout(300);
  check(!(await isOpen()) && await pane(page) === 'content', 'back arrow: closed, still on the chat');
  await page.goBack();
  await page.waitForTimeout(600);
  check(await pane(page) === 'list', 'Back after that: the channel list');
} finally {
  await browser.close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all ok');
