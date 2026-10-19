// A bot's video (no poster of ours) in Android's WebView: the WebView gives such a video its own
// grey poster and keeps it until the video plays or seeks. Imitated here (every <video> without a
// poster gets a grey one); the player's seek to the first instant must show the first frame.
//   node e2e/serve.mjs &   then   node e2e/webviewposter.mjs [screenshot.png]
// Needs ffmpeg (makes the test video).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';
const sharp = createRequire(import.meta.url)('sharp');
const png = (color, width, height) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const tmp = mkdtempSync(join(tmpdir(), 'voicaw-video-'));
const file = join(tmp, 'clip.mp4');
const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr}`);
const video = readFileSync(file);
const browser = await launchChrome();
const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const a = alice.page;
await a.click('button[aria-label="Add a guild"]');
await a.fill('#new-guild-name', 'Hooks');
await a.click('button:has-text("Create")');
await a.waitForSelector('.guild-channel.active:has-text("general")');
const chanUrl = a.url();
  // Channel settings → Webhooks → New Webhook, then rename it and give it a picture.
  await a.click('button[aria-label="Edit general"]');
  await a.click('[role="tab"]:has-text("Webhooks")');
  await a.click('button:has-text("New Webhook")');
  await a.fill('input[aria-label="Webhook name"]', 'Deploy Bot');
  await a.setInputFiles('input[aria-label="Webhook picture"]', { name: 'bot.png', mimeType: 'image/png', buffer: await png('#e0a030', 300, 300) });
  await a.click('.image-cropper button:has-text("Apply")'); // the cropper (see avatarcrop.mjs)
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  await a.click('button:has-text("Save Changes")');
  await a.waitForSelector('.webhook-name:has-text("Deploy Bot")');
  await a.waitForFunction(() => document.querySelector('.webhook-summary .webhook-avatar')?.src.includes('/profile-pics/webhooks/'));
  await a.click('button:has-text("Copy Webhook URL")');
  await a.waitForSelector('text=Copied!');
  const url = await a.evaluate(() => navigator.clipboard.readText());
  if (!url.startsWith(`${BASE}/api/webhooks/`)) throw new Error(`unexpected webhook URL ${url}`);
const form = new FormData();
form.append('payload_json', JSON.stringify({ username: 'Clip Bot', content: 'clip' }));
form.append('files[0]', new Blob([video], { type: 'video/mp4' }), 'clip.mp4');
const res = await fetch(url, { method: 'POST', body: form });
if (res.status !== 204) throw new Error(`webhook post: ${res.status}`);
// What Android's WebView does: a video with no poster gets its own (grey).
const grey = await png('#808080', 16, 9);
const greyUrl = `data:image/png;base64,${grey.toString('base64')}`;
await a.context().addInitScript((poster) => {
  new MutationObserver(() => document.querySelectorAll('video:not([poster])').forEach((v) => v.setAttribute('poster', poster)))
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['poster'] });
}, greyUrl);
await a.goto(chanUrl);
await a.waitForSelector('.message-files .video-player video', { timeout: 20000 });
await a.waitForTimeout(4000);
const el = await a.$('.message-files .video-player');
const shot = await el.screenshot(process.argv[2] ? { path: process.argv[2] } : {});
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
// testsrc2's left bar is red: grey (128, 128, 128) means the WebView's poster is still up.
const [r, g, b] = px(Math.round(info.width * 0.1), Math.round(info.height * 0.5));
await browser.close();
if (!(r > 200 && g < 80 && b < 80)) {
  console.log(`FAIL the first frame isn't shown (pixel ${r}, ${g}, ${b})`);
  process.exit(1);
}
console.log('webviewposter: ok');
