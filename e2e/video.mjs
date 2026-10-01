// Videos: the poster (only) before Play, streamed in pieces through the service worker,
// a seek to the middle downloads nothing before it, download, spoiler, phone.
//   node e2e/serve.mjs &   then   node e2e/video.mjs [screenshot dir]
// Needs ffmpeg (makes the test video).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const s3 = `http://localhost:${process.env.E2E_S3_PORT || Number(process.env.E2E_API_PORT || 3099) + 1}`;
const reads = async () => (await fetch(`${s3}/__reads`)).json();
const clearReads = () => fetch(`${s3}/__reads/clear`);

// A minute of moving picture and a tone, ~2 Mbit/s, with its index at the end (ffmpeg's
// default, like many phones' files), so playing and seeking need ranges from the end too.
const tmp = mkdtempSync(join(tmpdir(), 'voicaw-video-'));
const file = join(tmp, 'clip.mp4');
const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330',
  '-t', process.env.VIDEO_SECONDS || '60', '-c:v', 'libx264', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr}`);
const video = readFileSync(file);
const size = statSync(file).size;

const attach = async (page, name, { spoiler = false } = {}) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType: 'video/mp4', buffer: video });
  // The poster and length are read from the file before sending.
  await page.waitForTimeout(1500);
  if (spoiler) await page.click(`button[aria-label="Mark ${name} as spoiler"]`);
};

const controlled = (page) => page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
const row = (text) => `.each-dm-message-wrapper:has-text("${text}")`;
const state = (page, text) => page.$eval(`${row(text)} .video-player`, (p) => {
  const v = p.querySelector('video');
  return {
    poster: !!p.querySelector('.video-poster'),
    src: v?.getAttribute('src') ?? null,
    time: v?.currentTime ?? null,
    paused: v?.paused ?? null,
    error: !!p.querySelector('.video-error'),
  };
});
const videoKey = (rs) => {
  const sizes = new Map();
  for (const r of rs) sizes.set(r.key, Math.max(sizes.get(r.key) ?? 0, r.end + 1));
  return [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0];
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  // The <video> in the message containing `text` (page side; :has-text is Playwright's).
  for (const user of [alice, bob]) {
    await user.page.context().addInitScript(() => {
      window.videoIn = (text) => [...document.querySelectorAll('.each-dm-message-wrapper')]
        .find((r) => r.textContent.includes(text))?.querySelector('video');
    });
  }
  // The service worker takes over from the next load.
  for (const user of [alice, bob]) {
    await user.page.reload();
    await controlled(user.page);
  }
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  // Alice sends it; Bob's phone shows its poster, length and size, and has read only the poster.
  await clearReads();
  await attach(alice.page, 'clip.mp4');
  await send(alice.page, 'watch this');
  await bob.page.waitForSelector(`${row('watch this')} .video-poster`, { timeout: 20000 });
  await bob.page.waitForTimeout(2000);
  const before = await reads();
  // (Alice's copy reads the poster too.)
  if (new Set(before.map((r) => r.key)).size !== 1 || before.some((r) => r.bytes > 200_000)) {
    throw new Error(`read before Play: ${JSON.stringify(before)}`);
  }
  const badge = await bob.page.textContent(`${row('watch this')} .video-badge`);
  if (!process.env.VIDEO_SECONDS && !badge.includes('1:00')) throw new Error(`badge: ${badge}`);
  await shot(bob.page, '1-phone-poster');
  await shot(alice.page, '2-sender');

  // Bob plays it: streamed through the service worker, a piece at a time.
  await clearReads();
  await bob.page.tap(`${row('watch this')} .video-big-play`);
  await bob.page.waitForFunction(() => window.videoIn("watch this")?.currentTime > 2, null, { timeout: 20000 });
  const playing = await state(bob.page, 'watch this');
  if (!playing.src.startsWith('/__voicaw-media/')) throw new Error(`not streamed: ${JSON.stringify(playing)}`);
  const played = await reads();
  const key = videoKey(played);
  const playedBytes = played.filter((r) => r.key === key).reduce((n, r) => n + r.bytes, 0);
  console.log(played.map((r) => `${r.start}-${r.end}`).join(" "));
  console.log(`playing 2 s read ${playedBytes} of ${size} bytes in ${played.length} requests`);
  if (process.env.VIDEO_TRACE) {
    for (let i = 0; i < 6; i++) {
      await bob.page.waitForTimeout(3000);
      const rs = (await reads()).filter((r) => r.key === key);
      const t = await bob.page.evaluate(() => window.videoIn('watch this').currentTime);
      console.log(`t=${t.toFixed(1)}s read ${rs.reduce((n, r) => n + r.bytes, 0)} max byte ${Math.max(...rs.map((r) => r.end))}`);
    }
  }
  if (playedBytes > size * 0.6) throw new Error('played: downloaded most of the file');
  await bob.page.tap(`${row('watch this')} .video-surface`);
  await bob.page.waitForTimeout(300);
  await shot(bob.page, '3-phone-playing-controls');

  // Alice reloads (no local copy now) and seeks to 75%: nothing before ~that is read.
  await alice.page.reload();
  await controlled(alice.page);
  await alice.page.waitForSelector(`${row('watch this')} .video-poster`, { timeout: 20000 });
  await alice.page.click(`${row('watch this')} .video-big-play`);
  await alice.page.waitForFunction(() => window.videoIn("watch this")?.currentTime > 0.5, null, { timeout: 20000 });
  await clearReads();
  const bar = await alice.page.$(`${row('watch this')} .video-seek`);
  const box = await bar.boundingBox();
  await alice.page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await alice.page.waitForFunction(() => {
    const v = window.videoIn("watch this");
    return v && v.currentTime > 46 && !v.paused && v.readyState >= 3;
  }, null, { timeout: 20000 });
  const seeked = (await reads()).filter((r) => r.key === key);
  const firstRead = Math.min(...seeked.map((r) => r.start));
  console.log(`seek to 75%: first byte read ${firstRead} of ${size} (${Math.round((firstRead / size) * 100)}%)`);
  if (firstRead < size * 0.6) throw new Error(`seek read from ${firstRead}: ${JSON.stringify(seeked)}`);
  await alice.page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await alice.page.waitForTimeout(300);
  await shot(alice.page, '4-desktop-seeked-hover');

  // Download: the whole (decrypted) file.
  const [download] = await Promise.all([
    alice.page.waitForEvent('download'),
    alice.page.click(`${row('watch this')} .video-controls .video-download`),
  ]);
  const saved = readFileSync(await download.path());
  if (!saved.equals(video)) throw new Error(`download: ${saved.length} bytes, not the video`);

  // Keyboard: k pauses, f full screen (and back).
  await alice.page.focus(`${row('watch this')} .video-player`);
  await alice.page.keyboard.press('k');
  if (!(await state(alice.page, 'watch this')).paused) throw new Error('k did not pause');
  await alice.page.keyboard.press('f');
  await alice.page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  await shot(alice.page, '5-fullscreen');
  await alice.page.keyboard.press('f');
  await alice.page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });

  // A spoiler: the poster blurred under the cover for Bob, the player once tapped.
  await attach(alice.page, 'twist.mp4', { spoiler: true });
  await send(alice.page, 'spoiler video');
  await bob.page.waitForSelector(`${row('spoiler video')} .attachment-spoiler img`, { timeout: 20000 });
  await bob.page.locator(`${row('spoiler video')}`).scrollIntoViewIfNeeded();
  await shot(bob.page, '6-phone-spoiler');
  await bob.page.tap(`${row('spoiler video')} .attachment-spoiler-reveal`);
  await bob.page.waitForSelector(`${row('spoiler video')} .video-big-play`);

  console.log('video: ok');
} finally {
  await browser.close();
}
