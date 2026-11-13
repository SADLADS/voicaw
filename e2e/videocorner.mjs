// A message's video playing on in the corner (services/floatingVideo.js): playing it, then
// going to another chat moves the same <video> element to the corner without a pause (nothing
// reloads); Go to message opens its chat and the video goes back into its message, still
// playing; Pop out (a window showing a copy of its picture; the page keeps playing it, frames
// arriving there), closing the window brings it back; Close stops it; a paused one just stops;
// Settings' "keep playing" off stops it; "when I scroll it out of view" on: scrolled away it
// goes to the corner and comes back scrolled to; dragged to the left it sits at the screen's
// edge, over the sidebar; phone: the back arrow (the chat pane slides away, still on the page)
// sends it to the corner (top right, narrower, no Pop out), opening the chat brings it back.
//   node e2e/serve.mjs &   then   node e2e/videocorner.mjs [screenshot dir]
// Needs ffmpeg (makes the test video).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

const tmp = mkdtempSync(join(tmpdir(), 'voicaw-videocorner-'));
const file = join(tmp, 'clip.mp4');
const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330',
  '-t', '60', '-c:v', 'libx264', '-b:v', '800k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr}`);
const video = readFileSync(file);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`ok - ${what}`);
};

const attach = async (page, name) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType: 'video/mp4', buffer: video });
  await page.waitForTimeout(1500);
};

// Another page inside the app, without loading the page again (which would end any video).
const go = async (page, path) => {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(400);
};

const row = (text) => `.each-dm-message-wrapper:has-text("${text}")`;
const controlled = (page) => page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });

// Plays the video in the message with `text`, remembers its element as window.__v and counts
// its pauses and reloads (emptied) from then on.
async function play(page, text, { tap = false } = {}) {
  await page.waitForSelector(`${row(text)} .video-big-play`, { timeout: 20000 });
  if (tap) await page.tap(`${row(text)} .video-big-play`);
  else await page.click(`${row(text)} .video-big-play`);
  await page.waitForFunction((t) => {
    const r = [...document.querySelectorAll('.each-dm-message-wrapper')].find((each) => each.textContent.includes(t));
    const v = r?.querySelector('video');
    return v && v.currentTime > 1.5 && !v.paused;
  }, text, { timeout: 20000 });
  await page.evaluate((t) => {
    const r = [...document.querySelectorAll('.each-dm-message-wrapper')].find((each) => each.textContent.includes(t));
    window.__v = r.querySelector('video');
    window.__pauses = 0;
    window.__reloads = 0;
    window.__v.addEventListener('pause', () => { window.__pauses += 1; });
    window.__v.addEventListener('emptied', () => { window.__reloads += 1; });
  }, text);
}

const where = (page) => page.evaluate(() => {
  const v = window.__v;
  return {
    inCorner: !!v?.closest('.corner-players .floating-video.corner'),
    inMessage: !!v?.closest('.each-dm-message-wrapper'),
    connected: !!v?.isConnected,
    time: v?.currentTime ?? null,
    paused: v?.paused ?? null,
    pauses: window.__pauses,
    reloads: window.__reloads,
    corner: !!document.querySelector('.floating-video.corner'),
  };
});

async function stillPlaying(page, what) {
  const a = await where(page);
  await page.waitForTimeout(1200);
  const b = await where(page);
  check(!b.paused && b.time > a.time + 0.8 && b.pauses === 0 && b.reloads === 0, `${what} (t ${a.time.toFixed(1)} → ${b.time.toFixed(1)}, ${b.pauses} pauses, ${b.reloads} reloads)`);
  return b;
}

const browser = await launchChrome({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  await bob.page.reload();
  await controlled(bob.page);
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  await attach(alice.page, 'clip.mp4');
  await send(alice.page, 'watch this');

  // Playing, Bob goes to another chat: the same element plays on in the corner.
  await play(bob.page, 'watch this');
  await go(bob.page, `/dm/${carol.id}`);
  await bob.page.waitForSelector('.floating-video.corner', { timeout: 5000 });
  let at = await where(bob.page);
  check(at.inCorner && !at.inMessage, 'the playing video moved to the corner');
  check(await bob.page.isVisible('.floating-video.corner >> text=clip.mp4'), 'the corner names the file');
  await stillPlaying(bob.page, 'it plays on there, never paused or reloaded');
  await shot(bob.page, '1-corner');

  // Dragged to the left, it snaps to the screen's own corner, over the rail and channel list.
  const title = await bob.page.$('.floating-video.corner .floating-video-title');
  const tb = await title.boundingBox();
  await bob.page.mouse.move(tb.x + 20, tb.y + 5);
  await bob.page.mouse.down();
  await bob.page.mouse.move(200, 700, { steps: 12 });
  await bob.page.mouse.up();
  await bob.page.waitForTimeout(300);
  const left = await bob.page.$eval('.floating-video.corner', (el) => el.getBoundingClientRect().left);
  check(Math.abs(left - 16) < 2, `dragged left, it sits at the screen's edge (left ${left}), over the sidebar`);
  await stillPlaying(bob.page, 'still playing after the drag');
  await shot(bob.page, '1b-corner-left');
  // Every theme, light ones especially (the corner's bar uses the popup colours).
  if (dir) {
    const theme = await bob.page.evaluate(() => document.documentElement.dataset.theme);
    for (const name of ['dark', 'light', 'familiar', 'halloween', 'christmas', 'slack']) {
      await bob.page.evaluate((n) => { document.documentElement.dataset.theme = n; }, name);
      await bob.page.waitForTimeout(150);
      await (await bob.page.$('.floating-video.corner')).screenshot({ path: `${dir}/theme-${name}.png` });
    }
    await bob.page.evaluate((n) => { document.documentElement.dataset.theme = n; }, theme);
  }

  // Go to message: back in its chat, the video back in its message, still playing.
  await bob.page.click('.floating-video.corner button[aria-label="Go to message"]');
  await bob.page.waitForFunction(() => !!window.__v?.closest('.each-dm-message-wrapper'), null, { timeout: 10000 });
  at = await where(bob.page);
  check(at.inMessage && !at.corner && bob.page.url().endsWith(`/dm/${alice.id}`), 'Go to message: its chat, the video back in its message');
  await stillPlaying(bob.page, 'still playing in the message');

  // Pop out from the corner: a window showing it, the page keeping the element.
  await go(bob.page, `/dm/${carol.id}`);
  await bob.page.waitForSelector('.floating-video.corner', { timeout: 5000 });
  const [popup] = await Promise.all([
    bob.page.waitForEvent('popup'),
    bob.page.click('.floating-video.corner button[aria-label="Pop out"]'),
  ]);
  await popup.waitForSelector('.floating-video.popout video.floating-video-mirror', { timeout: 5000 });
  const frames = () => popup.evaluate(() => document.querySelector('video.floating-video-mirror').getVideoPlaybackQuality().totalVideoFrames);
  const f1 = await frames();
  await popup.waitForTimeout(1500);
  const f2 = await frames();
  check(f2 > f1 + 10, `the window shows it playing (${f2 - f1} frames in 1.5 s)`);
  check(!(await bob.page.$('.floating-video.corner')), 'no corner while popped out');
  await stillPlaying(bob.page, 'the page\'s element plays on, unmoved');
  await shot(popup, '2-popout');
  // Seeking from the window moves the page's element.
  await popup.evaluate(() => {
    const seek = document.querySelector('.video-seek');
    const r = seek.getBoundingClientRect();
    seek.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width * 0.75, clientY: r.top + 2, pointerId: 1, button: 0 }));
    seek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width * 0.75, clientY: r.top + 2, pointerId: 1, button: 0 }));
  }).catch(() => {});
  await bob.page.waitForTimeout(500);
  at = await where(bob.page);
  check(at.time > 40, `seeking in the window seeks the video (at ${at.time.toFixed(1)} s)`);
  // Closing the window brings it back to the corner (its message isn't on this page).
  await popup.close();
  await bob.page.waitForSelector('.floating-video.corner', { timeout: 5000 });
  at = await where(bob.page);
  check(at.inCorner && !at.paused, 'closing the window: back in the corner, playing');

  // Close stops it.
  await bob.page.click('.floating-video.corner button[aria-label="Close"]');
  await bob.page.waitForTimeout(300);
  at = await where(bob.page);
  check(!at.corner && at.paused, 'Close: gone and stopped');

  // A paused video just stops when you leave.
  await openChat(bob.page, alice.id);
  await play(bob.page, 'watch this');
  await bob.page.evaluate(() => window.__v.pause());
  await go(bob.page, `/dm/${carol.id}`);
  await bob.page.waitForTimeout(500);
  check(!(await bob.page.$('.floating-video')), 'a paused video stays behind');

  // Setting off: it stops.
  await bob.page.evaluate(() => localStorage.setItem('pipPrefs', JSON.stringify({ onLeave: false, onScroll: false })));
  await bob.page.reload();
  await openChat(bob.page, alice.id);
  await play(bob.page, 'watch this');
  await go(bob.page, `/dm/${carol.id}`);
  await bob.page.waitForTimeout(500);
  check(!(await bob.page.$('.floating-video')), 'with "Keep videos playing" off, it stops');

  // Scrolled out of view, with that setting on: the corner, and back when scrolled to.
  await bob.page.evaluate(() => localStorage.setItem('pipPrefs', JSON.stringify({ onLeave: true, onScroll: true })));
  await bob.page.reload();
  await openChat(bob.page, alice.id);
  await play(bob.page, 'watch this');
  for (let i = 0; i < 14; i++) await send(alice.page, `line ${i}\n\nmore\n\nand more`);
  await bob.page.waitForSelector(`${row('line 13')}`, { timeout: 10000 });
  await bob.page.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight; });
  await bob.page.waitForSelector('.floating-video.corner', { timeout: 5000 });
  at = await where(bob.page);
  check(at.inCorner && !at.paused, 'scrolled out of view: in the corner, playing');
  await shot(bob.page, '3-scrolled');
  await bob.page.evaluate(() => document.querySelector('.video-player.away')?.scrollIntoView({ block: 'center' }));
  await bob.page.waitForFunction(() => !!window.__v?.closest('.each-dm-message-wrapper'), null, { timeout: 5000 });
  check(!(await bob.page.$('.floating-video.corner')), 'scrolled back: in its message again');
  await stillPlaying(bob.page, 'still playing');

  // Phone: top right, narrower, no Pop out.
  const phone = await signUp(browser, 'dave', { ...devices['Pixel 7'] });
  await phone.page.reload();
  await controlled(phone.page);
  await openChat(alice.page, phone.id);
  await attach(alice.page, 'clip.mp4');
  await send(alice.page, 'for the phone');
  await openChat(phone.page, alice.id);
  await play(phone.page, 'for the phone', { tap: true });
  // The header's back arrow: the chat pane slides away to the list (it stays on the page, out of
  // sight), which counts as leaving it.
  await phone.page.tap('.pane-back-button');
  await phone.page.waitForSelector('.floating-video.corner', { timeout: 5000 });
  const box = await phone.page.$eval('.floating-video.corner', (el) => {
    const r = el.getBoundingClientRect();
    return { right: window.innerWidth - r.right, top: r.top, width: r.width };
  });
  check(box.width <= 202 && box.right < 20 && box.top < 150, `phone: top right, ${box.width}px wide`);
  check(!(await phone.page.$('.floating-video.corner button[aria-label="Pop out"]')), 'phone: no Pop out');
  await stillPlaying(phone.page, 'phone: plays on');
  await shot(phone.page, '4-phone');
  // Back into the chat from the list: the video goes back into its message.
  await phone.page.tap('#dm-sidebar >> text=alice');
  await phone.page.waitForFunction(() => !!window.__v?.closest('.each-dm-message-wrapper') && !document.querySelector('.floating-video.corner'), null, { timeout: 5000 });
  await stillPlaying(phone.page, 'phone: back in its message, playing');
  console.log('all good');
} finally {
  await browser.close();
}
