// Phone: a tap on the image viewer's dark part closes it, and that tap's click doesn't land on
// the picture behind it in the chat (which would open the viewer again).
//   node e2e/serve.mjs &   then   node e2e/viewerclose.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// Wide and short, so the viewer shows it as a band across the middle with dark above and below.
const photo = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
     <rect width="800" height="200" fill="#36c"/><circle cx="600" cy="100" r="60" fill="#fd4"/>
   </svg>`)).jpeg().toBuffer();

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  await openChat(a, bob.id);
  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'band.jpg', mimeType: 'image/jpeg', buffer: photo });
  await send(a, 'look');

  const b = bob.page;
  await openChat(b, alice.id);
  const thumb = 'img.attachment-media[alt="band.jpg"]';
  await b.waitForFunction((sel) => {
    const img = document.querySelector(sel);
    return img && img.complete && img.naturalWidth > 0;
  }, thumb, { timeout: 20000 });
  const tbox = await b.locator(thumb).boundingBox();
  const cdp = await b.context().newCDPSession(b);
  const tap = async (point) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await b.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // Tap the dark part of the viewer at a point where the chat's picture is underneath.
  for (const round of [1, 2]) {
    await b.tap(thumb);
    await b.waitForSelector('.image-viewer-image');
    await b.waitForTimeout(400);
    const point = await b.evaluate((t) => {
      // A point of the thumbnail that the viewer shows as dark stage, not image or toolbar.
      for (let y = t.y + 4; y < t.y + t.height - 4; y += 4) {
        for (let x = t.x + 4; x < t.x + t.width - 4; x += 8) {
          if (document.elementFromPoint(x, y)?.classList.contains('image-viewer-stage')) return { x, y };
        }
      }
      return null;
    }, tbox);
    check(point, `round ${round}: the dark part of the viewer covers the picture behind it`);
    const behind = await b.evaluate(({ x, y }) => {
      const viewer = document.querySelector('.image-viewer');
      viewer.style.visibility = 'hidden';
      const el = document.elementFromPoint(x, y);
      viewer.style.visibility = '';
      return el?.matches('img.attachment-media, .attachment-media *, button:has(img.attachment-media)') ?? false;
    }, point);
    check(behind, `round ${round}: and that point is on the picture in the chat`);
    if (round === 1) await shot(b, 'viewer-open');

    await tap(point);
    await b.waitForSelector('.image-viewer', { state: 'detached', timeout: 3000 });
    await b.waitForTimeout(800);
    check(await b.locator('.image-viewer').count() === 0, `round ${round}: the tap closed the viewer and it stayed closed`);
  }
  await shot(b, 'viewer-closed');

  // A tap on the picture itself after that still opens it.
  await b.waitForTimeout(600);
  await tap({ x: tbox.x + tbox.width / 2, y: tbox.y + tbox.height / 2 });
  await b.waitForSelector('.image-viewer-image', { timeout: 3000 });
  check(true, 'a later tap on the picture opens the viewer again');

  console.log('viewerclose: ok');
} catch (err) {
  console.error('viewerclose: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
