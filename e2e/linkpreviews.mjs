// Link previews in a real browser, against a stand-in website on this machine (pages with
// OpenGraph tags, a picture, a video): in a guild channel the server fetches the links and a
// card, a picture and a video player appear for everyone, live; with Settings → Privacy's
// "Show pictures and videos from links straight away" off (Bob, on a phone) the cards' text
// shows but nothing is asked of the site until Show / Play; Remove Previews (the author's
// menu) takes them away for both; in a DM the server fetches nothing, and only links straight
// to a picture or a video show it, loaded by the browser.
// Needs ffmpeg (for the video). The throwaway API may fetch private addresses
// (LINK_PREVIEWS_ALLOW_PRIVATE in start-api.mjs), so the site can be on 127.0.0.1.
//   node e2e/serve.mjs &   then   node e2e/linkpreviews.mjs [screenshot dir]
import http from 'node:http';
import { mkdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// ---- The stand-in website ----
const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
const picture = (w, h, background) => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
const PIC = await picture(1200, 630, '#3080ff');
const CAT = await picture(600, 400, '#d8b930');
const scratch = mkdtempSync(join(tmpdir(), 'voicaw-lp-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(scratch, 'clip.mp4')]);
const CLIP = readFileSync(join(scratch, 'clip.mp4'));

const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3106);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Each run's links are new, so the API (which caches previews per link) fetches them again.
const RUN = `?run=${Date.now()}`;
const page = (head) => `<!doctype html><html><head>${head}</head><body><p>Body text</p></body></html>`;
const PAGES = {
  '/article': page(`<title>Fallback title</title>
    <meta property="og:title" content="A stand-in article">
    <meta property="og:description" content="What the page says about itself, from its OpenGraph tags.">
    <meta property="og:site_name" content="Stand-in News">
    <meta property="og:image" content="/pic.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="theme-color" content="#3080ff">`),
  '/small': page('<title>A small card</title><meta name="description" content="With a thumbnail beside it."><meta property="og:image" content="/pic.png">'),
};
const served = []; // { path, bot }
const site = http.createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname;
  served.push({ path, bot: /VoicawBot/.test(req.headers['user-agent'] ?? '') });
  if (PAGES[path]) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[path]);
  if (path === '/pic.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIC);
  if (path === '/cat.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(CAT);
  if (path === '/clip.mp4') return res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': CLIP.length }).end(CLIP);
  res.writeHead(404).end();
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));
const botFetched = () => served.filter((s) => s.bot).map((s) => s.path);

// Everything a page asks of the site.
function watch(p) {
  const asked = [];
  p.on('request', (r) => {
    if (r.url().startsWith(SITE)) asked.push(r.url().slice(SITE.length));
  });
  return asked;
}

const api = (p, method, path, body) => p.evaluate(async ([m, url, b]) => {
  const res = await fetch(`/api${url}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}, [method, path, body]);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const askedA = watch(a);
  const askedB = watch(b);

  console.log('settings');
  await b.goto(new URL('/settings#privacy', a.url()).href);
  const toggle = b.getByLabel('Show pictures and videos from links straight away');
  check(await toggle.isChecked(), 'on by default');
  await toggle.uncheck();
  const prefs = await b.evaluate(() => JSON.parse(localStorage.getItem('privacy')));
  check(prefs.linkPreviews === false, 'Bob turned it off (saved on the device)');
  await toggle.scrollIntoViewIfNeeded();
  await shot(b, 'settings');

  console.log('guild channel');
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Previews');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildId = Number(new URL(a.url()).pathname.split('/')[2]);
  const { code } = await api(a, 'POST', `/guilds/${guildId}/invites`);
  await api(b, 'POST', `/invites/${code}`);
  await b.goto(a.url());
  await b.waitForSelector('#dm-input');

  await send(a, `Have a look ${SITE}/article${RUN} and ${SITE}/small${RUN} then ${SITE}/cat.png${RUN} and ${SITE}/clip.mp4${RUN}`);
  await a.waitForSelector('.embed-title:has-text("A stand-in article")', { timeout: 15000 });
  await a.waitForSelector('.embed-title:has-text("A small card")');
  await a.waitForSelector(`img.attachment-media[src="${SITE}/cat.png${RUN}"]`);
  await a.waitForSelector('.message-embeds video');
  check(['/article', '/small', '/cat.png', '/clip.mp4'].every((p) => botFetched().includes(p)), `the server fetched the links (${botFetched().join(', ')})`);
  const card = await a.evaluate(() => {
    const article = [...document.querySelectorAll('.embed')].find((e) => e.textContent.includes('A stand-in article'));
    const small = [...document.querySelectorAll('.embed')].find((e) => e.textContent.includes('A small card'));
    return {
      provider: article.querySelector('.embed-provider')?.textContent,
      description: article.querySelector('.embed-description')?.textContent,
      bar: getComputedStyle(article).borderLeftColor,
      image: article.querySelector('img.embed-image')?.getAttribute('src'),
      thumb: small.querySelector('img.embed-thumbnail')?.getAttribute('src'),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  check(card.provider === 'Stand-in News' && card.description.startsWith('What the page says'), 'card: site name and description');
  check(card.bar === 'rgb(48, 128, 255)', `card: theme colour bar (${card.bar})`);
  check(card.image === `${SITE}/pic.png` && card.thumb === `${SITE}/pic.png`, 'large picture on one, thumbnail on the other');
  check(!card.overflow, 'nothing overflows');
  await a.waitForFunction(() => [...document.querySelectorAll('.message-embeds img')].every((img) => img.complete));
  await shot(a, 'guild-desktop');
  check(askedA.includes('/pic.png') && askedA.includes(`/cat.png${RUN}`), "Alice's browser loaded the pictures (setting on)");

  // Bob: the text, but nothing from the site.
  await b.waitForSelector('.embed-title:has-text("A stand-in article")', { timeout: 15000 });
  await b.waitForSelector('button[aria-label="Show picture from 127.0.0.1"]');
  await b.waitForTimeout(1000);
  check(askedB.length === 0, `Bob's browser asked the site nothing (${askedB.join(', ') || 'nothing'})`);
  const phone = await b.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth, video: document.querySelector('.message-embeds video')?.getAttribute('src') ?? null }));
  check(!phone.overflow, 'phone: nothing overflows');
  check(phone.video === null, 'phone: the video has nothing to load before Play');
  await shot(b, 'guild-phone-held-back');
  await b.locator('.attachment-gif-hidden button').first().click();
  await b.waitForSelector(`.message-embeds img[src="${SITE}/pic.png"]`);
  check(askedB.includes('/pic.png'), 'Show loads that picture');
  await shot(b, 'guild-phone-shown');

  console.log('remove previews');
  await a.locator('.dm-message-content', { hasText: 'Have a look' }).click({ button: 'right', position: { x: 10, y: 8 } });
  await a.waitForSelector('.context-menu');
  await a.click('.context-menu [role="menuitem"]:has-text("Remove Previews")');
  await a.waitForSelector('.message-embeds', { state: 'detached' });
  await b.waitForSelector('.message-embeds', { state: 'detached', timeout: 10000 });
  check(true, 'gone for Alice and, live, for Bob');
  await a.reload();
  await a.waitForSelector('.dm-message-content:has-text("Have a look")');
  check(!(await a.$('.message-embeds')), 'still gone after a reload');

  console.log('the X beside a preview');
  await send(a, `Another ${SITE}/small${RUN}&x=1`);
  const xCard = a.locator('.removable-embed', { hasText: 'A small card' });
  await xCard.waitFor({ timeout: 15000 });
  const xButton = xCard.locator('button[aria-label="Remove previews"]');
  check(await xButton.evaluate((el) => getComputedStyle(el).opacity) === '0', 'hidden until the preview is hovered');
  await xCard.hover();
  await a.waitForFunction(() => getComputedStyle(document.querySelector('.remove-embed-button')).opacity === '1');
  const place = await xCard.evaluate((wrap) => {
    const card = wrap.querySelector('.embed').getBoundingClientRect();
    const x = wrap.querySelector('.remove-embed-button').getBoundingClientRect();
    const column = wrap.closest('.dm-message-content').clientWidth;
    return { gap: x.left - card.right, top: x.top - card.top, width: card.width, column };
  });
  check(place.gap >= 0 && place.gap < 10 && Math.abs(place.top) < 2, `beside the card's top right corner (${JSON.stringify(place)})`);
  check(Math.round(place.width) === Math.min(520, place.column), 'the card keeps its width (520, or the column)');
  await shot(a, 'remove-x-hover');
  await b.waitForSelector('.embed-title:has-text("A small card")', { timeout: 15000 });
  check(!(await b.$('.remove-embed-button')), 'no X on a phone (the action sheet has Remove previews)');
  await xButton.click();
  await a.waitForSelector('.vc-dialog:has-text("Remove all the previews")');
  await shot(a, 'remove-x-confirm');
  await a.click('.vc-dialog button.btn-danger');
  await a.waitForSelector('.removable-embed', { state: 'detached' });
  await b.waitForSelector('.embed-title:has-text("A small card")', { state: 'detached', timeout: 10000 });
  check(true, 'confirmed: gone for Alice and Bob');
  await send(a, `Once more ${SITE}/small${RUN}&x=2`);
  await xCard.waitFor({ timeout: 15000 });
  await xCard.hover();
  await xButton.click({ modifiers: ['Shift'] });
  await a.waitForSelector('.removable-embed', { state: 'detached' });
  check(!(await a.$('.vc-dialog')), 'Shift: removed without asking');
  // A YouTube player with the X keeps its size (its 100% width once fell back to the iframe's 300px).
  await send(a, 'A video https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const player = a.locator('.removable-embed .youtube-wrapper').last();
  await player.waitFor({ timeout: 15000 });
  const size = await player.evaluate((el) => ({ width: el.getBoundingClientRect().width, column: el.closest('.dm-message-content').clientWidth }));
  check(Math.round(size.width) === Math.min(500, size.column), `a YouTube player with the X keeps its width (500, or the column: ${JSON.stringify(size)})`);

  console.log('DM');
  const before = botFetched().length;
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  await send(a, `In a DM ${SITE}/article?dm=1 and ${SITE}/cat.png?dm=1`);
  await a.waitForSelector(`img.attachment-media[src="${SITE}/cat.png?dm=1"]`, { timeout: 15000 });
  await b.waitForSelector('button[aria-label="Show picture from 127.0.0.1"]', { timeout: 15000 });
  await a.waitForTimeout(1500);
  check(botFetched().length === before, 'the server fetched nothing for the DM');
  check(!(await a.$('.embed')), 'no page card in a DM');
  check(!askedB.includes('/cat.png?dm=1'), "Bob's browser didn't load the DM's picture (held back)");
  await shot(a, 'dm-desktop');
  await shot(b, 'dm-phone');
  console.log('linkpreviews: ok');
} catch (err) {
  console.error('linkpreviews: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
}
