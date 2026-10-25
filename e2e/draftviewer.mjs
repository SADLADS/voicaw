// Pictures attached to a message being written open in the image viewer from the tray: click
// (tap on a phone) a thumbnail, the viewer shows it large, steps to the tray's other picture
// (not the text file), offers no link for it, and closing it leaves the draft as it was.
//   node e2e/serve.mjs &   then   node e2e/draftviewer.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const picture = (fill, width, height) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${fill}"/></svg>`,
)).png().toBuffer();
const files = [
  { name: 'green.png', mimeType: 'image/png', buffer: await picture('#2a6', 1200, 800) },
  { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  { name: 'blue.png', mimeType: 'image/png', buffer: await picture('#26c', 600, 900) },
];

// Opens the viewer from `name`'s thumbnail and checks it, then steps on and closes it.
async function viewDrafts(page, phone) {
  const thumb = `button[aria-label="View green.png"]`;
  check(await page.locator('button[aria-label="View notes.txt"]').count() === 0, 'the text file has no View button');
  if (phone) await page.tap(thumb); else await page.click(thumb);
  await page.waitForSelector('.image-viewer-image');
  await page.waitForFunction(() => {
    const img = document.querySelector('.image-viewer-image');
    return img?.complete && img.naturalWidth === 1200;
  }, null, { timeout: 10000 });
  const box = await page.locator('.image-viewer-image').boundingBox();
  check(box.width > 200, `the picture shows large (${Math.round(box.width)} px wide)`);
  check((await page.textContent('.image-viewer-name')) === 'green.png', 'named green.png');
  check(await page.locator('.image-viewer-thumbnail').count() === 2, 'the strip has the two pictures, not the text file');
  await shot(page, phone ? 'phone-viewer' : 'viewer');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.image-viewer-name')?.textContent === 'blue.png');
  check(true, 'steps to blue.png');

  if (!phone) {
    await page.click('.image-viewer-image', { button: 'right' });
    const menu = await page.locator('.image-menu, [role="menu"]').last().innerText();
    check(!menu.includes('Copy Link') && menu.includes('Open Image'), 'its menu offers Open Image, no link');
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.image-viewer', { state: 'detached' });
  check(await page.locator('.attachment-draft').count() === 3, 'closed: the three drafts are still there');
  check(page.url().includes('/dm'), 'still in the chat (the viewer\'s history entry went back)');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  console.log('computer:');
  const [chooser] = await Promise.all([
    alice.page.waitForEvent('filechooser'),
    alice.page.click('.attach-button').then(() => alice.page.click('text=Upload a file')),
  ]);
  await chooser.setFiles(files);
  await alice.page.waitForSelector('.attachment-tray >> text=notes.txt');
  const cursor = await alice.page.$eval('.attachment-draft-open', (b) => getComputedStyle(b).cursor);
  check(cursor === 'zoom-in', `the thumbnail shows a zoom-in pointer (${cursor})`);
  await shot(alice.page, 'tray');
  await viewDrafts(alice.page, false);

  console.log('phone:');
  await bob.page.tap('.attach-button');
  const [phoneChooser] = await Promise.all([bob.page.waitForEvent('filechooser'), bob.page.tap('.attach-panel-bar button:has-text("Files")')]);
  await phoneChooser.setFiles(files);
  await bob.page.waitForSelector('.attachment-tray >> text=notes.txt');
  if (await bob.page.$('.attach-panel')) await bob.page.keyboard.press('Escape');
  await bob.page.waitForSelector('.attach-panel', { state: 'detached', timeout: 3000 }).catch(() => {});
  await shot(bob.page, 'phone-tray');
  await viewDrafts(bob.page, true);
  console.log('draftviewer: ok');
} catch (err) {
  console.error('draftviewer: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
