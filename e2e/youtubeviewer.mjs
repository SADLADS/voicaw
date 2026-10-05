// YouTube links on a phone (UrlPreviews.jsx, YouTubeViewer.jsx): the message holds only the
// thumbnail, so a swipe starting on it moves the panes; tapping it plays the video full screen
// (16:9, fitted, playing), and X / the back button close that, staying on the chat. A computer
// keeps the inline player. Real YouTube: needs the internet.
//   node e2e/serve.mjs &   then   node e2e/youtubeviewer.mjs [screenshot dir]
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

async function drag(page, { x, y, dx, steps = 6, ms = 10 }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y);
    await new Promise((r) => setTimeout(r, ms));
  }
  await touch('touchEnd');
  await cdp.detach();
}

// The <video> in YouTube's frame is playing (null until it's there).
const playing = async (page) => {
  const frame = page.frames().find((f) => f.url().includes('youtube-nocookie.com/embed/'));
  if (!frame) return null;
  return frame.evaluate(() => {
    const video = document.querySelector('video');
    return video ? !video.paused && video.currentTime > 0 : null;
  }).catch(() => null);
};
const waitPlaying = async (page, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await playing(page)) return true;
    await page.waitForTimeout(250);
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
  const preview = await page.waitForSelector('.youtube-preview');
  await settle(page);
  await page.waitForFunction(() => document.querySelector('.youtube-preview img')?.naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});
  check(await page.$('.messages-container iframe, .message-scroller iframe, .main-wrapper iframe') === null, 'the phone has no player in the chat');
  check(await page.$eval('.youtube-preview img', (img) => img.naturalWidth > 0), 'the thumbnail shows');
  await preview.scrollIntoViewIfNeeded();
  await shot(page, '1-preview');

  // A swipe starting on the thumbnail opens the list; swipe back.
  const box = await preview.boundingBox();
  const { width } = page.viewportSize();
  await drag(page, { x: box.x + 30, y: box.y + box.height / 2, dx: 250 });
  await settle(page);
  check(await pane(page) === 'list', 'a swipe that starts on the video opens the list');
  await drag(page, { x: width - 40, y: page.viewportSize().height * 0.5, dx: -width * 0.7, steps: 10, ms: 16 });
  await settle(page);
  const back = await pane(page);
  check(back === 'content', `and back to the chat (${back})`);

  // Tap: full screen, playing.
  const historyBefore = await page.evaluate(() => history.length);
  await page.tap('.youtube-preview');
  const frame = await page.waitForSelector('.youtube-viewer .youtube-viewer-frame');
  const fb = await frame.boundingBox();
  const vb = page.viewportSize();
  check(Math.abs(fb.width - vb.width) < 2 && Math.abs(fb.width / fb.height - 16 / 9) < 0.02, `the player fills the width at 16:9 (${Math.round(fb.width)}×${Math.round(fb.height)})`);
  const started = await waitPlaying(page);
  check(started, 'it plays straight away');
  await shot(page, '2-viewer');

  // Back: closed, still on the chat.
  await page.goBack();
  await page.waitForSelector('.youtube-viewer', { state: 'detached', timeout: 3000 }).catch(() => {});
  check(await page.$('.youtube-viewer') === null, 'the back button closes it');
  await settle(page);
  check(await pane(page) === 'content' && await page.evaluate(() => history.length) === historyBefore + 1, 'and stays on the chat');

  // X closes it too; turned sideways, it fits the height.
  await page.tap('.youtube-preview');
  await page.waitForSelector('.youtube-viewer');
  await page.setViewportSize({ width: vb.height, height: vb.width });
  await page.waitForTimeout(300);
  const wide = await page.$eval('.youtube-viewer-frame', (el) => el.getBoundingClientRect().toJSON());
  check(wide.height <= vb.width && wide.width <= vb.height + 1 && Math.abs(wide.width / wide.height - 16 / 9) < 0.02, `sideways it fits on screen (${Math.round(wide.width)}×${Math.round(wide.height)})`);
  await shot(page, '3-landscape');
  await page.setViewportSize(vb);
  await page.tap('.youtube-viewer button[aria-label="Close"]');
  await page.waitForSelector('.youtube-viewer', { state: 'detached', timeout: 3000 }).catch(() => {});
  check(await page.$('.youtube-viewer') === null, 'X closes it');
  await settle(page);
  check(await pane(page) === 'content', 'still on the chat');

  // A computer: inline player as before, no preview.
  await openChat(alice.page, bob.id);
  check(await alice.page.waitForSelector('.youtube-wrapper iframe').then(() => true, () => false), 'a computer plays it inline');
  check(await alice.page.$('.youtube-preview') === null, 'with no preview');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
