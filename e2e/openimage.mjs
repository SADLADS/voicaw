// Open Image in the desktop app (stand-in bridge) on an encrypted picture in a DM: it opens the
// web app in the browser at the picture, by where it is (chat, message, file, account), never
// with its key. A logged-out browser asks to log in, then shows the picture in the viewer; one
// logged in as someone else says so, logs out on request (keeping the link) and shows it after
// logging in as the right account. A picture with nowhere to link to has no Open Image.
//   node e2e/serve.mjs &   then   node e2e/openimage.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const items = (page) => page.$$eval('.context-menu [role^="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));

const photo = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260">
     <rect width="400" height="260" fill="#36c"/><circle cx="300" cy="80" r="50" fill="#fd4"/>
   </svg>`)).jpeg().toBuffer();

// The desktop app's bridge (electron/preload.js), as far as the page needs it here, and
// window.open recorded (the desktop app hands https links to the browser).
function fakeDesktop() {
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
    onNavigate: on(), onShortcut: on(), onUpdateReady: on(), onUpdateProgress: on(),
  };
  window.__opened = [];
  window.open = (url) => { window.__opened.push(String(url)); return null; };
}

async function logInHere(page, user) {
  await page.waitForSelector('input[placeholder="Username"]', { timeout: 15000 });
  await page.fill('input[placeholder="Username"]', user.name);
  await page.fill('input[placeholder="Password"]', user.password);
  await page.click('button:has-text("Login")');
}

// The viewer open on the decrypted picture.
async function viewerShowsPhoto(page) {
  await page.waitForSelector('.image-viewer-image', { timeout: 30000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('img.image-viewer-image');
    return img && img.complete && img.naturalWidth === 400;
  }, null, { timeout: 20000 });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  await a.context().addInitScript(fakeDesktop);
  await a.reload();
  await openChat(a, bob.id);

  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'sky.jpg', mimeType: 'image/jpeg', buffer: photo });
  await send(a, 'look');
  for (const text of ['one', 'two', 'three']) await send(a, text);
  const picture = a.locator('img.attachment-media[alt="sky.jpg"]');
  // Sent (a pending message has a temporary id) and decrypted.
  await a.waitForFunction(() => document.querySelector('[data-msg-id] img.attachment-media[alt="sky.jpg"]')
    ?.closest('[data-msg-id]')?.dataset.msgId.match(/^\d+$/), null, { timeout: 20000 });

  // The desktop app's menu: Open Image hands the browser a link without the key.
  await picture.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  check(JSON.stringify(await items(a)) === JSON.stringify(['Copy Image', 'Save Image', 'Open Image']), 'the desktop app offers Open Image');
  await a.click('.context-menu >> text=Open Image');
  const link = await a.waitForFunction(() => window.__opened[0], null, { timeout: 5000 }).then((h) => h.jsonValue());
  const msgId = await picture.evaluate((img) => img.closest('[data-msg-id]').dataset.msgId);
  const url = new URL(link);
  check(url.origin === BASE && url.pathname === `/dm/${bob.id}`, `the link is to the chat (${url.pathname})`);
  check(url.searchParams.get('message') === msgId && url.searchParams.get('as') === String(alice.id) && /\.bin$/.test(url.searchParams.get('image')),
    'with the message, the file and the account');
  check(!url.hash && !link.includes('k='), 'and no key');

  // A logged-out browser: log in, then the picture.
  const fresh = await (await browser.newContext({ viewport: { width: 1100, height: 750 } })).newPage();
  fresh.on('pageerror', (e) => console.log('[fresh] page error:', e.message));
  await fresh.goto(link);
  await shot(fresh, 'login');
  await logInHere(fresh, alice);
  await viewerShowsPhoto(fresh);
  check(true, 'logged out: logging in opens the picture in the viewer');
  check(!new URL(fresh.url()).searchParams.has('image'), 'and the link is taken out of the address');
  await shot(fresh, 'viewer');
  await fresh.keyboard.press('Escape');
  await fresh.waitForSelector('.image-viewer', { state: 'detached' });
  check(await fresh.locator(`[data-msg-id="${msgId}"]`).isVisible(), 'closing it leaves the chat at the message');

  // A browser logged in as Bob: told, logs out keeping the link, then Alice sees it.
  const b = bob.page;
  await b.goto(link);
  await b.waitForSelector('text=Another account\'s picture');
  const text = await b.textContent('.modal, [role="dialog"]');
  check(text.includes(alice.name) && text.includes(bob.name), 'logged in as someone else: says whose picture and who is logged in');
  check(await b.locator('.image-viewer').count() === 0, 'and shows nothing of it');
  await shot(b, 'other-account');
  await b.click('button:text-is("Log out")');
  await logInHere(b, alice);
  await viewerShowsPhoto(b);
  check(true, 'after logging out and in as the right account, the picture opens');

  // Cancel keeps the account and drops the link.
  const bob2 = await signUp(browser, 'bobby');
  await bob2.page.goto(link);
  await bob2.page.waitForSelector('text=Another account\'s picture');
  await bob2.page.click('button:text-is("Cancel")');
  await bob2.page.waitForSelector('text=Another account\'s picture', { state: 'detached' });
  check(!new URL(bob2.page.url()).searchParams.has('image'), 'Cancel drops the link and stays logged in');

  // Nowhere to link to (the picture in the viewer still has its place; a search result doesn't):
  // in the viewer, Open Image is there too.
  await picture.click();
  await a.waitForSelector('.image-viewer-image');
  const box = await a.locator('.image-viewer-image').boundingBox();
  await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await a.waitForSelector('.context-menu');
  check((await items(a)).includes('Open Image'), 'the viewer\'s menu offers it too');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await a.click('.image-viewer button[aria-label="Open in new tab"]');
  const fromButton = await a.waitForFunction(() => window.__opened[1], null, { timeout: 5000 }).then((h) => h.jsonValue());
  check(fromButton === link, 'and its Open in new tab button opens the same link');
  await a.keyboard.press('Escape');

  // A guild channel's picture, opened by a logged-out browser.
  const guild = await a.evaluate(async () => (await fetch('/api/guilds', {
    method: 'POST',
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Pictures' }),
  })).json());
  const general = guild.channels[0];
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  const [guildChooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await guildChooser.setFiles({ name: 'sky.jpg', mimeType: 'image/jpeg', buffer: photo });
  await send(a, 'in the guild');
  await a.waitForFunction(() => document.querySelector('[data-msg-id] img.attachment-media[alt="sky.jpg"]')
    ?.closest('[data-msg-id]')?.dataset.msgId.match(/^\d+$/), null, { timeout: 20000 });
  await a.locator('img.attachment-media[alt="sky.jpg"]').click({ button: 'right' });
  await a.click('.context-menu >> text=Open Image');
  const guildLink = await a.waitForFunction(() => window.__opened[0], null, { timeout: 5000 }).then((h) => h.jsonValue());
  check(new URL(guildLink).pathname === `/guild/${guild.id}/${general.id}` && new URL(guildLink).searchParams.get('in') === `channel-${general.id}`,
    'a guild channel\'s picture links to its channel');
  const guest = await (await browser.newContext({ viewport: { width: 1100, height: 750 } })).newPage();
  await guest.goto(guildLink);
  await logInHere(guest, alice);
  await viewerShowsPhoto(guest);
  check(true, 'and opens there after logging in');
  console.log('all ok');
} finally {
  await browser.close();
}
