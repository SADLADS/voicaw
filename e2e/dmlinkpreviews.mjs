// Link previews in end-to-end encrypted chats, made by the sender's app (see Link previews in
// docs/messages.md), against a stand-in website on this machine. Alice is the desktop app (a
// stand-in bridge whose fetchPage this script answers from Node, as electron/pageFetch.js
// would; that file and PageFetch.java have their own tests); Bob and Carol are browsers.
// Alice's DM gets a video card (like outplayed.tv's: og:video + picture) and an article card,
// live for both; the server only ever has ciphertext and fetches nothing; Bob still sees them
// after a reload; an edit makes them again (a link taken out loses its card); a group DM's
// (Carol on a phone: fits); none from Bob (the web app can't make them, nothing asked of the
// site), nor from Alice with Settings → Privacy's "Show link previews" off.
// Needs ffmpeg (for the video).
//   node e2e/serve.mjs &   then   node e2e/dmlinkpreviews.mjs [screenshot dir]
import http from 'node:http';
import { mkdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// ---- The stand-in website ----
const scratch = mkdtempSync(join(tmpdir(), 'voicaw-dmlp-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(scratch, 'clip.mp4')]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3080ff:size=480x270', '-frames:v', '1', join(scratch, 'pic.png')]);
const CLIP = readFileSync(join(scratch, 'clip.mp4'));
const PIC = readFileSync(join(scratch, 'pic.png'));

const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3107);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const RUN = `?run=${Date.now()}`;
const page = (head) => `<!doctype html><html><head>${head}</head><body><p>Body text</p></body></html>`;
const PAGES = {
  '/clip': page(`<meta property="og:title" content="A stand-in clip">
    <meta property="og:description" content="Captured by a stand-in capture app.">
    <meta property="og:image" content="/pic.png"><meta property="og:image:width" content="480"><meta property="og:image:height" content="270">
    <meta property="og:video:url" content="/clip.mp4"><meta property="og:video:secure_url" content="/clip.mp4">
    <meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="480"><meta property="og:video:height" content="270">
    <meta property="og:type" content="video.other"><meta name="twitter:card" content="player">`),
  '/article': page(`<meta property="og:title" content="A stand-in article"><meta property="og:site_name" content="Stand-in News">
    <meta property="og:description" content="What the page says about itself."><meta property="og:type" content="article">`),
  '/off': page('<meta property="og:title" content="Should not be fetched">'),
  '/web': page('<meta property="og:title" content="Should not be fetched either">'),
  '/group': page('<meta property="og:title" content="A page for the group"><meta property="og:image" content="/pic.png">'),
};
const served = []; // { path, by: 'desktop' | 'server' | 'browser' }
const site = http.createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname;
  const ua = req.headers['user-agent'] ?? '';
  served.push({ path, by: /StandInDesktop/.test(ua) ? 'desktop' : /VoicawBot/.test(ua) ? 'server' : 'browser' });
  if (PAGES[path]) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[path]);
  if (path === '/pic.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIC);
  if (path === '/clip.mp4') return res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': CLIP.length }).end(CLIP);
  res.writeHead(404).end();
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));
const pagesFetched = (by) => served.filter((s) => s.by === by && PAGES[s.path]).map((s) => s.path);

// What electron/pageFetch.js answers, from Node: { status, url, contentType, html (pages only) }.
async function standInFetch(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StandInDesktop' } });
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const out = { status: res.status, url: res.url, contentType };
    if (contentType === 'text/html') out.html = await res.text();
    else await res.body?.cancel();
    return out;
  } catch {
    return null;
  }
}

function fakeBridge() {
  const on = () => () => () => {};
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: () => {},
    setUnread: () => {},
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, shortcuts: {} }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: async () => {},
    fetchPage: (url) => window.__standInFetch(url),
    onNavigate: on(), onShortcut: on(), onUpdateReady: on(), onUpdateProgress: on(),
  };
}

const api = (p, method, path, body) => p.evaluate(async ([m, url, b]) => {
  const res = await fetch(`/api${url}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}, [method, path, body]);

const titles = (p) => p.$$eval('.embed-title', (els) => els.map((e) => e.textContent.trim()));

const browser = await launchChrome();
try {
  // Alice is the desktop app: the bridge exists from the first page load.
  const aliceContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await aliceContext.exposeFunction('__standInFetch', standInFetch);
  await aliceContext.addInitScript(fakeBridge);
  const alice = await signUp(browser, 'alice').then(async (made) => {
    const p = await aliceContext.newPage();
    p.on('pageerror', (e) => console.log('[alice desktop] page error:', e.message));
    p.on('dialog', (d) => d.accept());
    await p.goto(`${BASE}/`);
    await p.fill('input[placeholder="Username"]', made.name);
    await p.fill('input[placeholder="Password"]', made.password);
    await p.press('input[placeholder="Password"]', 'Enter');
    await p.waitForSelector('#dm-main', { timeout: 20000 });
    await made.page.context().close();
    return { ...made, page: p };
  });
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob, carol);
  const [a, b, c] = [alice.page, bob.page, carol.page];
  const askedB = [];
  b.on('request', (r) => { if (r.url().startsWith(SITE)) askedB.push(new URL(r.url()).pathname); });

  console.log('a DM from the desktop app');
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  await send(a, `Look at this ${SITE}/clip${RUN} and ${SITE}/article${RUN}`);
  await a.waitForSelector('.embed-title:has-text("A stand-in clip")', { timeout: 15000 });
  await a.waitForSelector('.embed-title:has-text("A stand-in article")');
  check(true, "Alice's app made the cards, and shows them");
  await b.waitForSelector('.embed-title:has-text("A stand-in clip")', { timeout: 15000 });
  await b.waitForSelector('.embed-title:has-text("A stand-in article")');
  const card = await b.evaluate(() => {
    const clip = [...document.querySelectorAll('.embed')].find((e) => e.textContent.includes('A stand-in clip'));
    const article = [...document.querySelectorAll('.embed')].find((e) => e.textContent.includes('A stand-in article'));
    return {
      description: clip.querySelector('.embed-description')?.textContent,
      video: clip.querySelector('video') !== null,
      provider: article.querySelector('.embed-provider')?.textContent,
    };
  });
  check(card.description === 'Captured by a stand-in capture app.' && card.video, `Bob sees the video card live, with its player (${JSON.stringify(card)})`);
  check(card.provider === 'Stand-in News', "and the article's card");
  await shot(b, '01-bob-dm-cards');
  check(JSON.stringify(pagesFetched('desktop').sort()) === JSON.stringify(['/article', '/clip']), `only Alice's app fetched the pages (${pagesFetched('desktop')})`);
  check(pagesFetched('server').length === 0, 'the server fetched nothing');
  check(!askedB.includes('/clip') && !askedB.includes('/article'), "Bob's browser didn't ask for the pages");

  const rows = await api(b, 'GET', `/dm-messages/${alice.id}`);
  const row = rows.at(-1);
  check(typeof row.link_previews === 'string' && row.link_previews.startsWith('v1.') && !row.link_previews.includes('stand-in'),
    'the server has the previews only encrypted');

  await b.reload();
  await b.waitForSelector('.embed-title:has-text("A stand-in clip")', { timeout: 15000 });
  check((await titles(b)).length === 2, 'Bob still sees both after a reload');

  console.log('an edit');
  await a.locator('.dm-message-content', { hasText: 'Look at this' }).click({ button: 'right', position: { x: 10, y: 8 } });
  await a.click('.context-menu [role="menuitem"]:has-text("Edit Message")');
  const editor = a.locator('.each-dm-message-wrapper [contenteditable="true"]');
  await editor.waitFor();
  await a.keyboard.press('Control+A');
  await a.keyboard.type(`Just this one ${SITE}/clip${RUN}`);
  await a.keyboard.press('Enter');
  await b.waitForSelector('.embed-title:has-text("A stand-in article")', { state: 'detached', timeout: 15000 });
  await b.waitForSelector('.embed-title:has-text("A stand-in clip")', { timeout: 15000 });
  check(JSON.stringify(await titles(b)) === JSON.stringify(['A stand-in clip']), 'after the edit Bob sees only the card for the link left');

  console.log('nothing from the web app, or with previews off');
  await send(b, `From the browser ${SITE}/web${RUN}`);
  await a.waitForSelector('.dm-message-content:has-text("From the browser")');
  await a.waitForTimeout(2500);
  check(!(await titles(a)).includes('Should not be fetched either') && !pagesFetched('desktop').includes('/web') && !askedB.includes('/web'),
    "Bob's browser made no preview and asked the site nothing");
  await a.goto(`${BASE}/settings#privacy`);
  await a.getByLabel('Show link previews').uncheck();
  await openChat(a, bob.id);
  await send(a, `Previews off ${SITE}/off${RUN}`);
  await b.waitForSelector('.dm-message-content:has-text("Previews off")');
  await b.waitForTimeout(2500);
  check(!pagesFetched('desktop').includes('/off') && !(await titles(b)).includes('Should not be fetched'), 'with "Show link previews" off, Alice\'s app fetched nothing');
  await a.goto(`${BASE}/settings#privacy`);
  await a.getByLabel('Show link previews').check();

  console.log('a group DM');
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Clips');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await send(a, `For the group ${SITE}/group${RUN}`);
  await a.waitForSelector('.embed-title:has-text("A page for the group")', { timeout: 15000 });
  await c.goto(`${BASE}/dm`);
  const href = await c.getAttribute('.dm-group:has-text("Clips")', 'href');
  await c.goto(`${BASE}${href}`);
  await c.waitForSelector('.embed-title:has-text("A page for the group")', { timeout: 20000 });
  const phone = await c.evaluate(() => {
    const embed = document.querySelector('.embed').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > window.innerWidth, fits: embed.right <= window.innerWidth };
  });
  check(!phone.overflow && phone.fits, `Carol (phone) sees the group message's card, and it fits (${JSON.stringify(phone)})`);
  await shot(c, '02-carol-group-card');
  const groupRows = await api(c, 'GET', `/group-dms/${href.split('/').pop()}/messages`);
  check(groupRows.some((m) => typeof m.link_previews === 'string' && m.link_previews.startsWith('v2.')), "the group message's previews are signed and encrypted (v2.)");

  console.log('all good');
} finally {
  await browser.close();
  site.close();
}
