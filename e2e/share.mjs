// Sharing to Voicaw from another app (the Android app's share sheet; stand-in Capacitor bridge
// sending the `share` event as Share.java does): a link shared to one chat (the share screen,
// that chat opened, Carol reads it decrypted), then two pictures and a message to a DM and a
// guild channel at once: the chats you last sent to listed first (#general, then Carol),
// search, the files read and uploaded once for both, Bob sees the pictures decrypted, the
// guild message has them; light theme and the phone's width.
//   node e2e/serve.mjs &   then   node e2e/share.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import sharp from 'sharp';
import { launchChrome, signUp, openChat, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const picture = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
     <rect width="480" height="320" fill="#48f"/><circle cx="240" cy="160" r="90" fill="#fd4"/>
   </svg>`)).png().toBuffer();

// Runs in the page before the app: Capacitor's native bridge, with the events it sends.
function fakeAndroid() {
  const listeners = {};
  const answers = {
    checkNotifications: () => ({ permission: 'granted', fullScreen: true, push: false }),
    setSystemBars: () => undefined,
    checkForUpdate: () => ({ supported: false }),
    showToast: ({ message }) => { window.__android.toasts.push(message); },
  };
  window.__android = { toasts: [], emit: (event, data) => (listeners[event] ?? []).forEach((cb) => cb(data)) };
  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: [{
      name: 'Voicaw',
      methods: [
        ...Object.keys(answers).map((name) => ({ name, rtype: 'promise' })),
        { name: 'addListener', rtype: 'callback' },
        { name: 'removeListener', rtype: 'promise' },
      ],
    }],
    convertFileSrc: (path) => location.origin + path.replace('content:/', '/_capacitor_content_'),
    nativePromise: async (plugin, method, options) => answers[method]?.(options ?? {}),
    nativeCallback: (plugin, method, options, callback) => {
      (listeners[options.eventName] ??= []).push(callback);
      return `cb-${Math.random()}`;
    },
  };
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}, [method, path, body]);

const dialog = '.share-dialog';
const rowNames = (page) => page.$$eval(`${dialog} .share-dialog-list li .user-picker-name`, (els) => els.map((e) => e.firstChild.textContent));
const tick = (page, name) => page.locator(`${dialog} label.user-picker-row`, { has: page.locator(`.user-picker-name:text-is("${name}")`) })
  .locator('input[type="checkbox"]').check();
// Waits for the listener: the page is ready once Layout has added it.
const emitShare = (page, share) => page.waitForFunction((s) => {
  const ready = window.__android && document.querySelector('#dm-main, .main-content-wrapper');
  if (ready) window.__android.emit('share', s);
  return ready && document.querySelector('.share-dialog');
}, share, { timeout: 15000 });

const browser = await launchChrome();
try {
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const alice = await signUp(browser, 'alice', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob, carol);
  const page = alice.page;
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('[alice error]', m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() === 403) console.log('[alice] 403 from', r.url()); });
  const guild = await api(page, 'POST', '/guilds', { name: 'Share club' });
  const general = guild.channels[0];

  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.context().addInitScript(fakeAndroid);
  const reads = [];
  await page.route('**/_capacitor_content_/**', (route) => {
    reads.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: picture });
  });
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('#dm-main');

  // 1. A link, shared to one chat: that chat opens with it sent.
  await emitShare(page, { files: [], text: 'https://example.com/hello', skipped: 0 });
  check(await page.inputValue(`${dialog} textarea`) === 'https://example.com/hello', 'the shared text is the message');
  check(await page.isDisabled(`${dialog} .vc-dialog-actions button`), 'nothing picked: Send waits');
  await tick(page, carol.name);
  await page.click(`${dialog} button:text-is("Send to 1 chat")`);
  await page.waitForSelector(dialog, { state: 'detached' });
  await page.waitForURL(`**/dm/${carol.id}`);
  await page.waitForSelector('.each-dm-message-wrapper:has-text("https://example.com/hello")');
  check(true, 'sent to one chat, which then opens with it');
  check((await page.evaluate(() => window.__android.toasts)).includes('Sent to 1 chat.'), 'a toast says so');
  await openChat(carol.page, alice.id);
  await carol.page.waitForSelector('.each-dm-message-wrapper:has-text("https://example.com/hello")');
  check(true, 'Carol reads it (decrypted)');

  // 2. Then a guild message: #general is where Alice last sent.
  await api(page, 'POST', `/channels/${general.id}/messages`, { content: 'hello club' });
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('#dm-main');
  const files = [1, 2].map((n) => ({ uri: `content://media/external/images/media/${n}`, name: `holiday${n}.png`, type: 'image/png', size: picture.length }));
  await emitShare(page, { files, text: 'Look at these', skipped: 1 });
  await page.waitForFunction((d) => document.querySelector(`${d} .share-dialog-list li .user-picker-name`)?.textContent.startsWith('general'), dialog);
  const order = await rowNames(page);
  check(order[0] === 'general' && order[1] === carol.name, `last sent to first: ${order.slice(0, 4).join(', ')}`);
  check(await page.locator(`${dialog} .share-dialog-file img`).count() === 2, 'both pictures previewed');
  await page.waitForFunction((d) => [...document.querySelectorAll(`${d} .share-dialog-file img`)].every((i) => i.complete && i.naturalWidth > 0), dialog);
  check(await page.isVisible(`${dialog} .share-dialog-note:has-text("1 file couldn't be shared.")`), 'says a file was left out');
  check(await page.isVisible(`${dialog} li:has-text("general") .forward-dialog-note:text-is("Not encrypted")`), 'guild channels say they are not encrypted');
  const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(width[0] <= width[1], `fits the phone (${width[0]} of ${width[1]} px)`);
  await shot(page, 'share-dark');

  await page.fill(`${dialog} input[type="search"]`, 'bo');
  const searched = await rowNames(page);
  check(searched.length === 1 && searched[0] === bob.name, `search finds Bob (${searched.join(', ')})`);
  await tick(page, bob.name);
  await page.fill(`${dialog} input[type="search"]`, '');
  await tick(page, 'general');
  const readsBefore = reads.length;
  const urlBefore = page.url();
  await page.click(`${dialog} button:text-is("Send to 2 chats")`);
  await page.waitForSelector(dialog, { state: 'detached', timeout: 30000 });
  check(reads.length - readsBefore === 2, `each file read from the phone once for both chats (${reads.length - readsBefore})`);
  check(page.url() === urlBefore, `two chats: stays where it was (${urlBefore.replace(BASE, '')} → ${page.url().replace(BASE, '')})`);
  check((await page.evaluate(() => window.__android.toasts)).includes('Sent to 2 chats.'), 'a toast says where');

  await openChat(bob.page, alice.id);
  await bob.page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.each-dm-message-wrapper')].find((r) => r.textContent.includes('Look at these'));
    const imgs = row ? [...row.querySelectorAll('img.attachment-media')] : [];
    return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 20000 });
  check(true, 'Bob sees the message and both pictures (decrypted)');
  await shot(bob.page, 'share-bob');

  const inGuild = await api(page, 'GET', `/channels/${general.id}/messages`);
  const last = (Array.isArray(inGuild) ? inGuild : inGuild.messages ?? []).find((m) => m.content?.startsWith('Look at these'));
  check(last && (last.content.match(/\/uploads\//g) ?? []).length === 2, 'the guild message has both pictures');
  await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await page.waitForFunction(() => [...document.querySelectorAll('img.attachment-media')].filter((i) => i.complete && i.naturalWidth > 0).length >= 2, null, { timeout: 20000 });
  check(true, 'and shows them in the channel');

  // 3. Light theme.
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('#dm-main');
  await emitShare(page, { files, text: '', skipped: 0 });
  await page.waitForTimeout(500);
  await shot(page, 'share-light');
  await page.click(`${dialog} .vc-dialog-close`);
  await page.waitForSelector(dialog, { state: 'detached' });
  check(true, '× closes it without sending');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
