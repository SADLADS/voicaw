// YouTube players in messages on a phone (UrlPreviews.jsx YouTubePlayer): a swipe that starts
// on the video still moves the panes (touches on YouTube's frame never reach our page, so a
// shield covers it), a tap plays and pauses it, YouTube's control bar is left uncovered, and a
// computer has no shield. Real YouTube: needs the internet.
//   node e2e/serve.mjs &   then   node e2e/youtubeswipe.mjs [screenshot dir]
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

const pane = (page) => page.evaluate(() => {
  const w = document.querySelector('.main-wrapper');
  if (w.classList.contains('panes-moving')) return 'moving';
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'none';
});
const settle = (page) => page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });

async function touches(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    async drag({ x, y, dx, steps = 6, ms = 10 }) {
      await touch('touchStart', x, y);
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', x + (dx * i) / steps, y);
        await new Promise((r) => setTimeout(r, ms));
      }
      await touch('touchEnd');
    },
    async tap(x, y) {
      await touch('touchStart', x, y);
      await touch('touchEnd');
    },
  };
}

// The <video> inside YouTube's frame: playing or not (null until it's there).
const playing = async (page) => {
  const frame = page.frames().find((f) => f.url().includes('youtube-nocookie.com/embed/'));
  if (!frame) return null;
  return frame.evaluate(() => {
    const video = document.querySelector('video');
    return video ? !video.paused : null;
  }).catch(() => null);
};
const waitPlaying = async (page, want, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await playing(page) === want) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const page = bob.page;
  await openChat(page, alice.id);
  const wrapper = await page.waitForSelector('.youtube-wrapper iframe');
  await settle(page);
  // Until YouTube's embed answers our page (the shield can only play it after that).
  await page.waitForFunction(() => document.querySelector('.youtube-wrapper iframe')?.src.includes('enablejsapi=1'));
  await page.waitForTimeout(3000);
  const box = await wrapper.boundingBox();
  await shot(page, '1-chat');

  // The shield: over the video, not over the bottom 48px (YouTube's control bar).
  const shield = await page.$eval('.youtube-shield', (el) => {
    const r = el.getBoundingClientRect();
    return { shown: getComputedStyle(el).display !== 'none', height: r.height };
  });
  check(shield.shown && Math.abs(shield.height - (box.height - 48)) < 2, 'the phone has a shield over the video, its control bar left open');
  const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: box.x + box.width / 2, y: box.y + box.height - 20 });
  check(top !== 'youtube-shield', 'touches on the control bar go to YouTube');

  const t = await touches(page);
  // A tap on the video plays it, another pauses it.
  await t.tap(box.x + box.width / 2, box.y + box.height / 2);
  const started = await waitPlaying(page, true);
  check(started, 'a tap on the video plays it');
  await shot(page, '2-playing');
  if (started) {
    await page.waitForTimeout(1500);
    await t.tap(box.x + box.width / 2, box.y + box.height / 2);
    check(await waitPlaying(page, false), 'another tap pauses it');
  }
  check(await pane(page) === 'content', 'tapping it leaves the chat where it is');

  // A swipe starting on the video: the list.
  await t.drag({ x: box.x + 30, y: box.y + box.height / 2, dx: 250 });
  await settle(page);
  check(await pane(page) === 'list', 'a swipe that starts on the video opens the list');
  await shot(page, '3-list');

  // A computer: no shield, clicks go to YouTube's player.
  await openChat(alice.page, bob.id);
  await alice.page.waitForSelector('.youtube-wrapper iframe');
  check(await alice.page.$eval('.youtube-shield', (el) => getComputedStyle(el).display === 'none'), 'a computer has no shield');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
