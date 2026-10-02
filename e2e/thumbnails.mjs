// Image thumbnails: a big photo shows as a smaller copy (turned the way its EXIF says, without
// the EXIF), and only the copy downloads until the viewer opens it; Save gives the file exactly
// as sent (EXIF and all). Transparent images keep their transparency; animated PNGs, GIFs and
// small images get no copy. Desktop sender, phone receiver.
//   node e2e/serve.mjs &   then   node e2e/thumbnails.mjs [screenshot dir]
// Needs ffmpeg (makes the animated PNG).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, signUp, openChat, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const s3 = `http://localhost:${process.env.E2E_S3_PORT || Number(process.env.E2E_API_PORT || 3099) + 1}`;
const reads = async () => (await fetch(`${s3}/__reads`)).json();
const clearReads = () => fetch(`${s3}/__reads/clear`);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// A busy picture (so the JPEG is big), 4000×3000, stored sideways: EXIF says turn it (6 =
// 90° clockwise), so it shows 3000×4000. Its EXIF also names a camera.
const scene = (w, h, alpha = 1) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
     <defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#36c"/><stop offset="1" stop-color="#c63"/></linearGradient></defs>
     <rect width="${w}" height="${h}" fill="url(#g)" fill-opacity="${alpha}"/>
     ${Array.from({ length: 400 }, (_, i) => `<circle cx="${(i * 997) % w}" cy="${(i * 613) % h}" r="${20 + (i % 60)}" fill="hsl(${i * 37 % 360},70%,55%)"/>`).join('')}
   </svg>`);
const photo = await sharp(scene(4000, 3000)).jpeg({ quality: 92 })
  .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'VoicawCam', Model: 'Thumb 1' } } }).toBuffer();
const clear = await sharp(scene(3000, 2000, 0)).png().toBuffer();
const small = await sharp(scene(400, 260)).jpeg().toBuffer();
const gif = await sharp(scene(1600, 1200)).gif().toBuffer();
const tmp = mkdtempSync(join(tmpdir(), 'voicaw-thumbs-'));
const apngPath = join(tmp, 'moving.png');
const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2000x1500:rate=4',
  '-t', '1', '-plays', '0', '-f', 'apng', apngPath]);
if (made.status !== 0) throw new Error(`ffmpeg failed: ${made.stderr}`);
const apng = readFileSync(apngPath);
const files = {
  'photo.jpg': { mimeType: 'image/jpeg', buffer: photo },
  'clear.png': { mimeType: 'image/png', buffer: clear },
  'moving.png': { mimeType: 'image/png', buffer: apng },
  'still.gif': { mimeType: 'image/gif', buffer: gif },
  'small.jpg': { mimeType: 'image/jpeg', buffer: small },
};
check(photo.includes('VoicawCam'), `the photo (${photo.length} bytes) has EXIF`);

// What each picture in the chat shows: its size, type and bytes, from its decrypted blob.
const shown = (page) => page.$$eval('img.attachment-media[alt]', (imgs) => Promise.all(imgs.map(async (img) => {
  const blob = await (await fetch(img.src)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Whether any pixel of the shown copy is see-through.
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return {
    name: img.alt,
    width: img.naturalWidth,
    height: img.naturalHeight,
    type: blob.type,
    size: blob.size,
    camera: new TextDecoder('latin1').decode(bytes).includes('VoicawCam'),
    transparent: ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v < 255),
  };
})));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  for (const [who, page] of [['alice', a], ['bob', b]]) {
    page.on('console', (m) => m.type() === 'error' && console.log(`  [${who}] ${m.text()}`));
  }
  await openChat(a, bob.id);
  await openChat(b, alice.id);

  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles(Object.entries(files).map(([name, f]) => ({ name, ...f })));
  await a.waitForTimeout(2000); // sizes and thumbnails are made before sending
  await clearReads();
  // (A click in the middle of the box would land on a chip and select it: type at the end.)
  await a.focus('#dm-input');
  await a.keyboard.press('Control+End');
  await a.keyboard.type('pictures');
  await a.keyboard.press('Enter');

  const count = Object.keys(files).length;
  const loaded = (page) => page.waitForFunction((n) => [...document.querySelectorAll('img.attachment-media[alt]')]
    .filter((i) => i.complete && i.naturalWidth > 0).length >= n, count, { timeout: 30000 }).catch(async (err) => {
    console.log(await page.$$eval('img.attachment-media, .attachment-loading, .attachment-file', (els) => els.map((e) => `${e.className} ${e.alt ?? e.getAttribute('aria-label') ?? e.textContent} ${e.complete} ${e.naturalWidth}`)));
    throw err;
  });
  await loaded(b);
  await b.waitForTimeout(1000);
  const onPhone = Object.fromEntries((await shown(b)).map((s) => [s.name, s]));
  console.log(onPhone);

  // The photo: a copy fitting 840×720, upright (EXIF turned), without the EXIF.
  const p = onPhone['photo.jpg'];
  check(p.width === 540 && p.height === 720 && p.type === 'image/jpeg', `photo shown as a ${p.width}×${p.height} ${p.type}, upright`);
  check(!p.camera && p.size < photo.length / 4, `its copy (${p.size} bytes) has no EXIF and is far smaller`);
  // The transparent one: a copy that keeps its transparency.
  const c = onPhone['clear.png'];
  check(c.width === 840 && c.type === 'image/webp' && c.transparent, `transparent image shown as an ${c.width}px ${c.type}, still transparent`);
  // The rest as they are.
  check(!p.transparent, 'the photo has no transparency');
  check(onPhone['moving.png'].width === 2000 && onPhone['moving.png'].size === apng.length, 'the animated PNG is shown as sent');
  check(onPhone['still.gif'].width === 1600 && onPhone['still.gif'].size === gif.length, 'the GIF is shown as sent');
  check(onPhone['small.jpg'].width === 400 && onPhone['small.jpg'].size === small.length, 'the small JPEG is shown as sent');

  // Read from the store: two copies' worth for the thumbnailed ones, not the photo or the
  // transparent image themselves (Alice's own copies are local).
  const read = await reads();
  const total = read.reduce((n, r) => n + r.bytes, 0);
  const sent = apng.length + gif.length + small.length;
  console.log(`read ${total} bytes in ${read.length} requests; untouched files ${sent}, photo ${photo.length}, transparent ${clear.length}`);
  check(total < sent + photo.length / 4 + clear.length / 2, 'the phone downloaded the copies, not the big files');
  await shot(b, '1-phone-chat');
  await shot(a, '2-sender');

  // Opening the photo in the viewer downloads and shows the file itself.
  await clearReads();
  await b.tap('img.attachment-media[alt="photo.jpg"]');
  await b.waitForFunction(() => document.querySelector('.image-viewer-image')?.naturalWidth > 0, null, { timeout: 20000 });
  const full = await b.$eval('.image-viewer-image', (img) => [img.naturalWidth, img.naturalHeight]);
  check(full[0] === 3000 && full[1] === 4000, `the viewer shows the file itself, ${full.join('×')}`);
  const viewerRead = (await reads()).reduce((n, r) => n + r.bytes, 0);
  check(viewerRead >= photo.length, `opening it read the file (${viewerRead} bytes)`);
  const strip = await b.$$eval('.image-viewer-thumbnail img', (imgs) => imgs.length);
  check(strip === count, `the strip shows all ${count}`);
  await b.waitForTimeout(500);
  await shot(b, '3-phone-viewer');
  await b.keyboard.press('Escape');

  // Alice reloads (no local copies), saves the photo from its menu: the file exactly as sent.
  await a.reload();
  await loaded(a);
  const desktop = Object.fromEntries((await shown(a)).map((s) => [s.name, s]));
  check(desktop['photo.jpg'].width === 540, 'after a reload the sender sees the copy too');
  await a.click('img.attachment-media[alt="photo.jpg"]', { button: 'right' });
  await a.waitForSelector('.context-menu');
  const [download] = await Promise.all([a.waitForEvent('download'), a.click('.context-menu >> text=Save Image')]);
  const saved = readFileSync(await download.path());
  check(saved.equals(photo), `Save Image gives the file exactly as sent (${saved.length} bytes, EXIF kept)`);
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await shot(a, '4-desktop-after-reload');
  console.log('thumbnails: all good');
} catch (err) {
  for (const [i, context] of browser.contexts().entries()) await shot(context.pages()[0], `failed-${i}`);
  throw err;
} finally {
  await browser.close();
}
