// Pictures' own menu (in place of the browser's): right-click a picture in a message or in the
// full-screen viewer for Copy Image (a PNG on the clipboard), Save Image, and Copy / Open Link
// (a plain picture) or Open Image (an encrypted attachment, which has no link to share). Over
// the viewer it sits on top, and Escape closes only the menu. On a phone, holding the picture
// in the viewer opens it as a sheet.
//   node e2e/serve.mjs &   then   node e2e/imagemenu.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const items = (page, sel) => page.$$eval(`${sel} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const photo = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260">
     <rect width="400" height="260" fill="#36c"/><circle cx="300" cy="80" r="50" fill="#fd4"/>
   </svg>`)).jpeg().toBuffer();

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await openChat(a, bob.id);

  // An encrypted attachment and a plain picture (a link to one).
  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'sky.jpg', mimeType: 'image/jpeg', buffer: photo });
  await send(a, 'look');
  const plainUrl = `${BASE}/default.png`;
  await send(a, `![logo](${plainUrl})`);
  await a.waitForFunction(() => [...document.querySelectorAll('img.attachment-media')].filter((i) => i.complete && i.naturalWidth > 0).length >= 2, null, { timeout: 20000 });
  const encrypted = a.locator('img.attachment-media[alt="sky.jpg"]');
  const plain = a.locator(`img.attachment-media[src="${plainUrl}"]`);

  // The plain picture: link items; Copy Image puts a PNG on the clipboard; Copy Link its URL.
  await plain.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  check(same(await items(a, '.context-menu'), ['Copy Image', 'Save Image', 'Copy Link', 'Open Link']), "a plain picture's menu");
  await shot(a, 'plain-menu');
  await a.click('.context-menu >> text=Copy Image');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  const types = await a.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types));
  check(types.includes('image/png'), `Copy Image: the clipboard holds ${types.join(', ')}`);
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await plain.click({ button: 'right' });
  await a.click('.context-menu >> text=Copy Link');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check((await a.evaluate(() => navigator.clipboard.readText())) === plainUrl, 'Copy Link copies its URL');
  await a.waitForSelector('.context-menu', { state: 'detached' });

  // The encrypted one: no link; Save Image downloads the decrypted file under its name.
  await encrypted.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  check(same(await items(a, '.context-menu'), ['Copy Image', 'Save Image', 'Open Image']), "an encrypted attachment's menu has no link");
  const [download] = await Promise.all([a.waitForEvent('download'), a.click('.context-menu >> text=Save Image')]);
  check(download.suggestedFilename() === 'sky.jpg', `Save Image downloads ${download.suggestedFilename()}`);
  await a.waitForSelector('.context-menu', { state: 'detached' });

  // In the viewer: on top of it, and Escape closes the menu, not the viewer.
  await encrypted.click();
  await a.waitForSelector('.image-viewer-image');
  const box = await a.locator('.image-viewer-image').boundingBox();
  await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await a.waitForSelector('.context-menu');
  const onTop = await a.evaluate(() => {
    const item = document.querySelector('.context-menu [role="menuitem"]');
    const r = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  check(onTop, 'the menu shows over the viewer');
  await shot(a, 'viewer-menu');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check(await a.locator('.image-viewer').count() === 1, 'Escape closes the menu, the viewer stays');
  await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await a.click('.context-menu >> text=Copy Image');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  const viewerTypes = await a.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types));
  check(viewerTypes.includes('image/png'), 'Copy Image from the viewer (a decrypted JPEG, copied as PNG)');
  await a.keyboard.press('Escape');

  // Phone: hold the picture in the viewer.
  const b = bob.page;
  await openChat(b, alice.id);
  await b.waitForFunction(() => {
    const img = document.querySelector('img.attachment-media[alt="sky.jpg"]');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20000 });
  await b.tap('img.attachment-media[alt="sky.jpg"]');
  await b.waitForSelector('.image-viewer-image');
  await b.waitForTimeout(300);
  const pbox = await b.locator('.image-viewer-image').boundingBox();
  const cdp = await b.context().newCDPSession(b);
  const point = { x: pbox.x + pbox.width / 2, y: pbox.y + pbox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await b.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await b.waitForSelector('.context-sheet');
  check(same(await items(b, '.context-sheet'), ['Copy Image', 'Save Image', 'Open Image']), 'holding the picture in the viewer opens its sheet');
  check(await b.locator('.image-viewer').count() === 1, 'and the viewer stays open (the hold is not a tap)');
  await b.waitForTimeout(300);
  await shot(b, 'phone-sheet');
  const [phoneDownload] = await Promise.all([b.waitForEvent('download'), b.tap('.context-sheet >> text=Save Image')]);
  check(phoneDownload.suggestedFilename() === 'sky.jpg', 'Save Image from the sheet');
  await b.waitForSelector('.context-sheet', { state: 'detached' });

  console.log('imagemenu: ok');
} catch (err) {
  console.error('imagemenu: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
