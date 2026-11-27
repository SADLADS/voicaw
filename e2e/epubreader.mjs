// The EPUB reader (EPUB reader in docs/uploads.md), against the dev server (no
// Content-Security-Policy, so only the sanitising stops a book's code):
// - Alice attaches a book: its cover in the tray; Bob sees the cover before anything of the
//   book itself is downloaded (the store's reads), with Read and Download;
// - Read: the reader, chapter 1, a link to a place in chapter 2, the contents, next/previous,
//   text size, Back closes it, opening it again returns to where it was left;
// - a booby-trapped book (scripts, handlers, an SVG with a script, javascript: links, other
//   sites' pictures, CSS, fonts and frames, a fixed box over everything): nothing runs, nothing
//   is asked of another site, the box stays inside the page;
// - the same book in a guild channel; every theme; a phone.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { BASE, devices, launchChrome, signUp, openChat, send } from './helpers.mjs';
import { epub, xhtml } from '../client/src/test/epubFixture.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const s3 = `http://localhost:${process.env.E2E_S3_PORT || 3100}`;
const reads = async () => (await fetch(`${s3}/__reads`)).json();
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
};

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', 'X-Voicaw-Session': JSON.parse(localStorage.getItem('login')).sid },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const picture = (width, height, colour, text) => sharp({ create: { width, height, channels: 3, background: colour } })
  .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><text x="50%" y="50%" font-size="${Math.round(width / 8)}" text-anchor="middle" fill="white" font-family="sans-serif">${text}</text></svg>`) }])
  .png().toBuffer();

const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1}. The rain had stopped by the time the ferry reached the island, and the harbour lights came on one after another along the quay.</p>`).join('');

async function goodBook() {
  const nav = xhtml('<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="ch1.xhtml">The Ferry</a></li><li><a href="ch2.xhtml">The Island</a><ol><li><a href="ch2.xhtml#lighthouse">The Lighthouse</a></li></ol></li><li><a href="ch3.xhtml">Home</a></li></ol></nav>');
  const file = await epub({
    name: 'the-ferry.epub',
    files: {
      'nav.xhtml': nav,
      'style.css': 'h1 { font-family: serif; color: #000; text-align: center } p { text-indent: 1.5em; margin: 0 }',
      'ch1.xhtml': xhtml(`<h1>The Ferry</h1>${filler(12)}<p>Skip to <a href="ch2.xhtml#lighthouse">the lighthouse</a>.</p><p><img src="images/harbour.png" alt="The harbour"/></p>${filler(30)}`, '<link rel="stylesheet" href="style.css"/>'),
      'ch2.xhtml': xhtml(`<h1>The Island</h1>${filler(40)}<h2 id="lighthouse">The Lighthouse</h2>${filler(30)}`, '<link rel="stylesheet" href="style.css"/>'),
      'ch3.xhtml': xhtml(`<h1>Home</h1>${filler(5)}`, '<link rel="stylesheet" href="style.css"/>'),
      'images/harbour.png': new Uint8Array(await picture(600, 300, '#246', 'Harbour')),
      'images/cover.jpg': new Uint8Array(await picture(600, 900, '#a33', 'The Ferry')),
    },
    properties: { 'nav.xhtml': 'nav', 'images/cover.jpg': 'cover-image' },
    spine: ['c', 'd', 'e'],
  });
  return Buffer.from(await file.arrayBuffer());
}

const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" onload="window.pwned=\'svg onload\'"><script>window.pwned="svg script"</script><rect width="100" height="40" fill="#393"/><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.pwned=\'foreign\'"/></foreignObject><image href="https://evil.example/svg-image.png" width="10" height="10"/></svg>';
async function evilBook() {
  const file = await epub({
    name: 'trap.epub',
    files: {
      'trap.xhtml': xhtml(`<h1>Trap</h1>
        <script>window.pwned = 'script'</script>
        <img src="missing.png" onerror="window.pwned='onerror'" alt="missing"/>
        <img src="https://evil.example/track.png" alt="tracker"/>
        <img src="art.svg" alt="art"/>
        <svg width="20" height="20"><script>window.pwned='inline svg'</script><image href="https://evil.example/inline.png"/></svg>
        <div style="background: url(https://evil.example/bg.png); height: 10px">bg</div>
        <iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/obj"></object>
        <form action="https://evil.example/form"><input name="q"/><button>Go</button></form>
        <meta http-equiv="refresh" content="0;url=https://evil.example/refresh"/>
        <p><a id="js" href="javascript:window.pwned='link'">a javascript link</a></p>
        <p style="position: fixed; inset: 0; z-index: 2147483647; background: red; margin: 0">I cover everything</p>
        <style>@import url(https://evil.example/import.css); @font-face { font-family: X; src: url(https://evil.example/font.woff) } h1 { background: url(https://evil.example/h1.png) }</style>`,
      '<link rel="stylesheet" href="https://evil.example/head.css"/><base href="https://evil.example/"/><script src="https://evil.example/head.js"></script>'),
      'art.svg': EVIL_SVG,
    },
    spine: ['a'],
  });
  return Buffer.from(await file.arrayBuffer());
}

async function attach(page, name, buffer, text) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/epub+zip', buffer });
  return text;
}

const reader = (page) => page.locator('.epub-reader');
const heading = (page) => page.locator('.epub-reader-page h1').first();

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const offsite = [];
  for (const user of [alice, bob]) {
    user.page.on('request', (req) => { if (!/^(blob:|data:|http:\/\/localhost[:/])/.test(req.url())) offsite.push(req.url()); });
  }
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await fetch(`${s3}/__reads/clear`);

  // The cover in the tray while writing.
  await attach(alice.page, 'the-ferry.epub', await goodBook());
  await alice.page.locator('.attachment-tray img[alt="Cover of the-ferry.epub"]').waitFor({ timeout: 15000 });
  await shot(alice.page, '1-tray-cover');
  await send(alice.page, 'a book for you');

  // Bob: the cover, before anything of the book.
  const row = bob.page.locator('.each-dm-message-wrapper', { hasText: 'a book for you' });
  const cover = row.locator('img.attachment-book-cover');
  await cover.waitFor({ timeout: 20000 });
  await bob.page.waitForFunction(() => [...document.querySelectorAll('img.attachment-book-cover')].some((i) => i.complete && i.naturalWidth > 0));
  const coverSize = await cover.evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  check(coverSize[0] <= 280 && coverSize[1] <= 400 && Math.abs(coverSize[0] / coverSize[1] - 600 / 900) < 0.02, `cover redrawn small (${coverSize})`);
  const before = await reads();
  // (Alice's app shows her own sent cover too, so it may be read twice.)
  check(before.length >= 1 && new Set(before.map((r) => r.key)).size === 1 && before.every((r) => r.bytes < 30_000), `only the cover was downloaded before Read (${JSON.stringify(before)})`);
  check(await row.getByRole('button', { name: 'Read the-ferry.epub' }).isVisible(), 'Read button');
  check(await row.getByRole('button', { name: 'Download the-ferry.epub' }).isVisible(), 'Download button');
  await shot(bob.page, '2-chat-book');

  // Reading.
  await row.getByRole('button', { name: 'Read the-ferry.epub' }).click();
  await heading(bob.page).waitFor({ timeout: 15000 });
  check(await heading(bob.page).textContent() === 'The Ferry', 'opens at chapter 1');
  check(await bob.page.locator('.epub-reader-name').textContent() === 'The Book', 'title from the book');
  check(await bob.page.locator('.epub-reader-page img[alt="The harbour"]').evaluate((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth === 600), "the book's own picture shown");
  check(await bob.page.locator('.epub-reader-progress').textContent() === 'Chapter 1 of 3', 'progress');
  const toolbarBox = await bob.page.locator('.epub-reader-toolbar').boundingBox();
  check(toolbarBox.y === 0, 'reader covers the app');
  // The desktop app's title bar (html.has-title-bar): the reader starts below it and still reaches the window's bottom.
  const underBar = await bob.page.evaluate((sel) => {
    document.documentElement.classList.add('has-title-bar');
    const box = document.querySelector(sel).getBoundingClientRect();
    document.documentElement.classList.remove('has-title-bar');
    return [box.top, box.bottom, window.innerHeight];
  }, '.epub-reader');
  check(underBar[0] === 32 && underBar[1] === underBar[2], `below the desktop title bar, down to the bottom (${underBar})`);
  await shot(bob.page, '3-reader');

  await bob.page.locator('.epub-reader-page a', { hasText: 'the lighthouse' }).click();
  await bob.page.waitForFunction(() => document.querySelector('.epub-reader-progress')?.textContent === 'Chapter 2 of 3');
  await bob.page.waitForTimeout(300);
  const lighthouse = await bob.page.locator('.epub-reader-page h2#lighthouse').boundingBox();
  check(lighthouse && lighthouse.y > 0 && lighthouse.y < 200, `link went to the lighthouse in chapter 2 (y ${lighthouse?.y})`);
  check(bob.page.url().includes(`/dm/${alice.id}`) && !bob.page.url().includes('#'), 'the address did not change');

  await bob.page.getByRole('button', { name: 'Contents', exact: true }).click();
  await shot(bob.page, '4-contents');
  await bob.page.locator('.epub-reader-contents').getByRole('button', { name: 'Home' }).click();
  await bob.page.waitForFunction(() => document.querySelector('.epub-reader-progress')?.textContent === 'Chapter 3 of 3');
  await bob.page.getByRole('button', { name: /Previous chapter/ }).click();
  await bob.page.waitForFunction(() => document.querySelector('.epub-reader-progress')?.textContent === 'Chapter 2 of 3');

  const size = () => bob.page.locator('.epub-reader-page p').first().evaluate((p) => parseFloat(getComputedStyle(p).fontSize));
  const normal = await size();
  await bob.page.getByRole('button', { name: 'Bigger text' }).click();
  check(await size() > normal, 'Bigger text');
  await bob.page.getByRole('button', { name: 'Smaller text' }).click();

  // Scroll down a way, then Back closes it, and it opens again there.
  await bob.page.locator('.epub-reader-scroll').evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  await bob.page.waitForTimeout(700);
  await bob.page.goBack();
  await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });
  check(bob.page.url().includes(`/dm/${alice.id}`), 'Back closed the book, still in the chat');
  await row.getByRole('button', { name: 'Read the-ferry.epub' }).click();
  await bob.page.waitForFunction(() => document.querySelector('.epub-reader-progress')?.textContent === 'Chapter 2 of 3');
  await bob.page.waitForTimeout(500);
  const fraction = await bob.page.locator('.epub-reader-scroll').evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight));
  check(Math.abs(fraction - 0.5) < 0.03, `reopened where it was left (${fraction.toFixed(2)})`);
  await bob.page.keyboard.press('Escape');
  await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });

  // Themes.
  await row.getByRole('button', { name: 'Read the-ferry.epub' }).click();
  await heading(bob.page).waitFor();
  for (const theme of ['light', 'slack', 'halloween']) {
    await bob.page.evaluate((th) => localStorage.setItem('theme', th), theme);
    await bob.page.reload();
    await bob.page.waitForSelector('#dm-input');
    await row.getByRole('button', { name: 'Read the-ferry.epub' }).click();
    await bob.page.locator('.epub-reader-page p').first().waitFor();
    const colours = await bob.page.locator('.epub-reader-page h1').first().evaluate((h) => [getComputedStyle(h).color, getComputedStyle(document.querySelector('.epub-reader')).backgroundColor]);
    check(colours[0] !== colours[1], `${theme}: text readable on the page (${colours})`);
    await shot(bob.page, `5-reader-${theme}`);
    await bob.page.keyboard.press('Escape');
    await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });
    await bob.page.locator('img.attachment-book-cover').first().waitFor();
    await shot(bob.page, `5-chat-${theme}`);
  }
  await bob.page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await bob.page.reload();
  await bob.page.waitForSelector('#dm-input');

  // The trap.
  let dialogs = 0;
  bob.page.on('dialog', () => { dialogs += 1; });
  await attach(alice.page, 'trap.epub', await evilBook());
  await send(alice.page, 'open me');
  const trapRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'open me' });
  await trapRow.getByRole('button', { name: 'Read trap.epub' }).click({ timeout: 20000 });
  await heading(bob.page).waitFor({ timeout: 15000 });
  // (The book's fixed box covers the page, so the link is clicked from script.)
  await bob.page.locator('.epub-reader-page #js').dispatchEvent('click');
  await bob.page.waitForTimeout(1500);
  check(await bob.page.evaluate(() => window.pwned) === undefined, 'nothing in the book ran');
  check(dialogs === 0, 'no dialogs');
  check(offsite.length === 0, `nothing asked of another site (${offsite.join(', ')})`);
  check(await bob.page.locator('.epub-reader-page :is(script, iframe, object, form, input, meta, base, link, foreignObject)').count() === 0, 'no scripts, frames, forms or meta in the page');
  check(await bob.page.locator('.epub-reader-page .epub-svg-image svg rect').count() === 1, 'the SVG picture shown inline');
  const page = await bob.page.locator('.epub-reader-page').boundingBox();
  const fixed = await bob.page.locator('.epub-reader-page p', { hasText: 'I cover everything' }).boundingBox();
  check(fixed.x >= page.x - 1 && fixed.y >= page.y - 1 && fixed.x + fixed.width <= page.x + page.width + 1, 'the fixed box stays inside the page');
  const onClose = await bob.page.evaluate(() => {
    const button = document.querySelector('.epub-reader-toolbar button');
    const box = button.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button;
  });
  check(onClose, 'the toolbar stays on top');
  check(bob.page.url().includes(`/dm/${alice.id}`), 'no refresh or navigation');
  await shot(bob.page, '6-trap');
  await bob.page.keyboard.press('Escape');

  // A guild channel.
  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Books' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(alice.page, 'POST', `/guilds/${guildId}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  for (const user of [alice, bob]) {
    await user.page.goto(`${BASE}/guild/${guildId}`);
    await user.page.waitForSelector('#dm-input');
  }
  await attach(alice.page, 'the-ferry.epub', await goodBook());
  await alice.page.locator('.attachment-tray img').waitFor({ timeout: 15000 });
  await send(alice.page, 'in the guild');
  const guildRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'in the guild' });
  await guildRow.locator('img.attachment-book-cover').waitFor({ timeout: 20000 });
  await guildRow.getByRole('button', { name: 'Read the-ferry.epub' }).click();
  await heading(bob.page).waitFor({ timeout: 15000 });
  check(await heading(bob.page).textContent() === 'The Ferry', 'a guild channel book opens');
  await bob.page.keyboard.press('Escape');

  // A phone.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  await api(phone.page, 'POST', `/invites/${invite.code}`);
  await phone.page.goto(`${BASE}/guild/${guildId}`);
  const phoneRow = phone.page.locator('.each-dm-message-wrapper', { hasText: 'in the guild' });
  await phoneRow.locator('img.attachment-book-cover').waitFor({ timeout: 20000 });
  await shot(phone.page, '7-phone-chat');
  await phoneRow.getByRole('button', { name: 'Read the-ferry.epub' }).tap();
  await heading(phone.page).waitFor({ timeout: 15000 });
  const wide = await phone.page.evaluate(() => document.querySelector('.epub-reader-scroll').scrollWidth <= document.querySelector('.epub-reader-scroll').clientWidth);
  check(wide, 'phone: no sideways scrolling');
  await shot(phone.page, '7-phone-reader');
  await phone.page.getByRole('button', { name: 'Contents', exact: true }).tap();
  await shot(phone.page, '7-phone-contents');
  const panel = await phone.page.locator('.epub-reader-contents').boundingBox();
  check(panel.width <= devices['Pixel 7'].viewport.width, 'phone: contents fit');
  await phone.page.goBack();
  await reader(phone.page).waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'phone: Back closes it');
  console.log('all good');
} finally {
  await browser.close();
}
