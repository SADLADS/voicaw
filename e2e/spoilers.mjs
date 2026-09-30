// Spoiler images: marked in the attachment tray, blurred for both people until clicked (a tap
// on a phone), kept out of the image viewer until then, "📎 spoiler" in reply previews.
//   node e2e/serve.mjs &   then   node e2e/spoilers.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// A picture whose words would give it away.
const twist = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
     <rect width="480" height="320" fill="#2a6"/><circle cx="360" cy="90" r="60" fill="#fd4"/>
     <text x="30" y="200" font-size="64" font-family="sans-serif" fill="#fff">THE TWIST</text>
   </svg>`)).png().toBuffer();

// The message with the picture in it.
const PICTURE = '.each-dm-message-wrapper:has(img.attachment-media)';

// Whether its spoiler cover is there, and whether the image shows clearly.
const state = (page) => page.$eval(PICTURE, (row) => {
  const img = row.querySelector('img.attachment-media');
  return {
    covered: !!row.querySelector('.attachment-spoiler'),
    blur: getComputedStyle(img).filter,
    loaded: img.complete && img.naturalWidth > 0,
    inGallery: !!row.querySelector('[data-gallery-item]'),
  };
});

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  // Alice attaches the picture and marks it as a spoiler in the tray.
  const [chooser] = await Promise.all([
    alice.page.waitForEvent('filechooser'),
    alice.page.click('.attach-button'),
  ]);
  await chooser.setFiles({ name: 'ending.png', mimeType: 'image/png', buffer: twist });
  await alice.page.click('button[aria-label="Mark ending.png as spoiler"]');
  await alice.page.waitForSelector('.attachment-draft.spoiler');
  await shot(alice.page, '1-tray');
  await send(alice.page, 'no peeking');

  // Both see it covered; neither can open it in the viewer yet.
  for (const [who, page] of [['alice', alice.page], ['bob', bob.page]]) {
    await page.waitForFunction(() => {
      const img = document.querySelector('.attachment-spoiler img');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 20000 });
    const s = await state(page);
    if (!s.covered || !s.blur?.includes('blur') || s.inGallery) throw new Error(`${who}: not covered: ${JSON.stringify(s)}`);
  }
  await shot(alice.page, '2-sent-covered');
  await shot(bob.page, '3-phone-covered');

  // Bob taps it: it's revealed (not opened), and now opens in the viewer.
  await bob.page.tap('.attachment-spoiler-reveal');
  const revealed = await state(bob.page);
  if (revealed.covered || revealed.blur !== 'none' || !revealed.inGallery) throw new Error(`bob: not revealed: ${JSON.stringify(revealed)}`);
  if (await bob.page.$('.image-viewer')) throw new Error('bob: the tap also opened the viewer');
  await shot(bob.page, '4-phone-revealed');

  // Alice's copy stays covered; a reply's preview doesn't name it.
  if (!(await state(alice.page)).covered) throw new Error("alice: bob's reveal uncovered hers");
  await alice.page.hover(PICTURE);
  await alice.page.click(`${PICTURE} .icon-button:has(svg.fa-reply)`);
  await send(alice.page, 'replying');
  await bob.page.waitForSelector('text=replying', { timeout: 10000 });
  const preview = await bob.page.textContent('.each-dm-message-wrapper:has-text("replying") .reply-preview');
  if (!preview.includes('📎 spoiler') || preview.includes('ending.png')) throw new Error(`reply preview: ${preview}`);
  await shot(bob.page, '5-reply-preview');

  // Clicking to reveal on a computer works the same way.
  await alice.page.click('.attachment-spoiler-reveal');
  if ((await state(alice.page)).covered) throw new Error('alice: click did not reveal');
  console.log('spoilers: ok');
} catch (err) {
  console.error('spoilers: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
