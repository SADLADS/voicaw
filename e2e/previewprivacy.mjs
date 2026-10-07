// Settings → Privacy's "Show message text in notifications" and "Show link previews", in a real
// browser. Bob is the desktop app (a stand-in bridge records its notifications, as in
// desktop.mjs) and turns both off: a guild mention and a DM notify him with "New message", not
// their text; a guild message's page card and YouTube player don't show for him (Alice still
// sees them) while its invite card does, a picture linked in a DM shows nothing, and his
// browser asks the stand-in site for nothing. Turned back on, the text and previews return.
//   node e2e/serve.mjs &   then   node e2e/previewprivacy.mjs [screenshot dir]
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// A stand-in website with one page (OpenGraph tags) and a picture.
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3106);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const RUN = `?run=${Date.now()}`; // the API caches previews per link
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const site = http.createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname;
  if (path === '/article') {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><html><head><meta property="og:title" content="A stand-in article">'
      + '<meta property="og:description" content="What the page says."><meta property="og:image" content="/pic.png"></head><body></body></html>'
    );
  }
  if (path === '/pic.png' || path === '/cat.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
  res.writeHead(404).end();
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));

function fakeBridge() {
  const record = { notifications: [] };
  window.__desktop = { record };
  const on = () => () => () => {};
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: (n) => record.notifications.push(n),
    setUnread: () => {},
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, shortcuts: {} }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: async () => {},
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

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  // Bob is the desktop app: the bridge exists from the first page load.
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await bobContext.addInitScript(fakeBridge);
  const bob = await signUp(browser, 'bob').then(async (made) => {
    const page = await bobContext.newPage();
    page.on('pageerror', (e) => console.log('[bob desktop] page error:', e.message));
    await page.goto(`${BASE}/`);
    await page.fill('input[placeholder="Username"]', made.name);
    await page.fill('input[placeholder="Password"]', made.password);
    await page.press('input[placeholder="Password"]', 'Enter');
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await made.page.context().close();
    return { ...made, page };
  });
  const b = bob.page;
  const askedB = [];
  b.on('request', (r) => { if (r.url().startsWith(SITE)) askedB.push(r.url().slice(SITE.length)); });
  // The stand-in bridge's record starts again with every page load: Bob's page's first.
  const nextNotification = async () => {
    await b.waitForFunction(() => window.__desktop.record.notifications.length > 0, null, { timeout: 15000 });
    const { title, body } = (await b.evaluate(() => window.__desktop.record.notifications))[0];
    return { title, body };
  };
  // Bob somewhere else (so he's notified), once the server has his page's presence.
  const away = async () => {
    await b.goto(`${BASE}/settings`);
    await b.waitForLoadState('networkidle');
    await b.waitForTimeout(1500);
  };

  console.log('settings');
  await b.goto(`${BASE}/settings#privacy`);
  const textToggle = b.getByLabel('Show message text in notifications');
  const linkToggle = b.getByLabel('Show link previews');
  const mediaToggle = b.getByLabel('Show pictures and videos from links straight away');
  check(await textToggle.isChecked() && await linkToggle.isChecked(), 'both on by default');
  check(await b.getByRole('heading', { name: 'Notifications' }).count() > 0
    && await b.locator('.settings-card:has(h5:text-is("Notifications"))').getByLabel('Show message text in notifications').count() === 0,
  'the notification text switch is no longer under Notifications');
  await textToggle.uncheck();
  await linkToggle.uncheck();
  check(await mediaToggle.isDisabled(), '"pictures and videos straight away" is greyed out with previews off');
  const saved = await b.evaluate(async () => ({
    privacy: JSON.parse(localStorage.getItem('privacy')),
    previews: await new Promise((resolve) => {
      const open = indexedDB.open('voicaw-settings', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('settings').objectStore('settings').get('notificationPreviews');
        get.onsuccess = () => resolve(get.result);
      };
    }),
  }));
  check(saved.privacy.showLinkPreviews === false && saved.previews === false, 'saved on the device (localStorage, IndexedDB)');
  await b.locator('.settings-card:has(h5:text-is("Privacy"))').screenshot({ path: dir ? `${dir}/settings.png` : undefined });

  console.log('guild');
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Previews');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const [, , guildId, channelId] = new URL(a.url()).pathname.split('/');
  const { code } = await api(a, 'POST', `/guilds/${guildId}/invites`);
  await api(b, 'POST', `/invites/${code}`);
  await away();

  const text = `<@${bob.id}> look ${SITE}/article${RUN} and https://youtu.be/dQw4w9WgXcQ and ${BASE}/invite/${code}`;
  await api(a, 'POST', `/channels/${channelId}/messages`, { content: text });
  let n = await nextNotification();
  check(n.body === 'New message' && n.title.includes(alice.name), `guild mention: who and where, not the text (${JSON.stringify(n)})`);

  await a.waitForSelector('.embed-title:has-text("A stand-in article")', { timeout: 15000 });
  await a.waitForSelector('.youtube-wrapper');
  check(true, 'Alice sees the card and the YouTube player');
  await b.goto(a.url());
  await b.waitForSelector('.invite-embed', { timeout: 10000 });
  await b.waitForTimeout(1000);
  check(await b.locator('.message-embeds .embed').count() === 0, 'Bob: no page card');
  check(await b.locator('.youtube-wrapper').count() === 0, 'Bob: no YouTube player');
  check(await b.locator(`a[href="${SITE}/article${RUN}"]`).count() === 1, 'Bob: the link itself is there');
  await shot(b, 'guild-off');
  await shot(a, 'guild-alice');

  console.log('DM');
  await b.goto(`${BASE}/dm/${alice.id}`); // checks Alice's keys on this device
  await b.waitForSelector('#dm-input');
  await away();
  await openChat(a, bob.id);
  await a.click('#dm-input');
  await a.keyboard.type(`secret plans ${SITE}/cat.png${RUN}`);
  await a.keyboard.press('Enter');
  await a.waitForSelector(`img.attachment-media[src="${SITE}/cat.png${RUN}"]`);
  n = await nextNotification();
  check(n.body === 'New message' && n.title === alice.name, `DM: "New message" (${JSON.stringify(n.body)})`);
  await b.goto(`${BASE}/dm/${alice.id}`);
  await b.waitForSelector('.message:has-text("secret plans")');
  await b.waitForTimeout(800);
  check(await b.locator('img.attachment-media').count() === 0, 'Bob: no picture from the link');
  check(askedB.length === 0, `Bob's browser asked the site for nothing (${askedB.join(', ')})`);

  console.log('back on');
  await b.goto(`${BASE}/settings#privacy`);
  // The switch waits for the saved value (disabled, showing on, until then): check() alone
  // would see it on and do nothing.
  await (await textToggle.elementHandle()).waitForElementState('enabled');
  await textToggle.check();
  await linkToggle.check();
  // Saved before the page goes (a navigation can abort the IndexedDB write).
  await b.waitForFunction(() => new Promise((resolve) => {
    const open = indexedDB.open('voicaw-settings', 1);
    open.onsuccess = () => {
      const get = open.result.transaction('settings').objectStore('settings').get('notificationPreviews');
      get.onsuccess = () => resolve(get.result === true);
    };
  }));
  await away();
  await openChat(a, bob.id);
  await a.click('#dm-input');
  await a.keyboard.type('see you at 8');
  await a.keyboard.press('Enter');
  n = await nextNotification();
  check(n.body === 'see you at 8', `DM text in the notification again (${JSON.stringify(n.body)})`);
  await away();
  await api(a, 'POST', `/channels/${channelId}/messages`, { content: `<@${bob.id}> again` });
  n = await nextNotification();
  check(n.body.endsWith('again'), `guild text in the notification again (${JSON.stringify(n.body)})`);
  await b.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await b.waitForSelector('.embed-title:has-text("A stand-in article")', { timeout: 10000 });
  check(true, 'Bob sees the card again');
  console.log('all good');
} finally {
  await browser.close();
  site.close();
}
