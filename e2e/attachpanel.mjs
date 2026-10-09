// The message box's + button: on a phone a panel in the keyboard's place (AttachPanel), on a
// computer the menu with Create thread. Phone web: camera and Photos tiles (no gallery), the bar
// (Photos, Poll, Files, Timestamps; Thread only in a guild channel you may start threads in), full screen,
// a file from Files sent; the Android app (stand-in bridge, as in android.mjs): Allow access,
// the grid of photos, picking two (numbered, chips), taking one back, sending (Bob sees the
// picture); a computer's + menu starts a thread; the phone panel's Thread does too.
//   node e2e/serve.mjs &   then   node e2e/attachpanel.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

// A 2x2 PNG (red), the photos' stand-in.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBNAMDAKhCC/VyOwm3AAAAAElFTkSuQmCC', 'base64');

// Runs in the page before the app: Capacitor's native bridge with the Voicaw plugin's media
// methods (Media.java), photos not allowed until asked.
function fakeAndroid() {
  const record = { calls: [] };
  let access = 'none';
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i + 1}`,
    uri: `content://media/external/images/media/${i + 1}`,
    type: 'image/png',
    name: `photo${i + 1}.png`,
    size: 75,
  }));
  items[2] = { ...items[2], id: 'v3', uri: 'content://media/external/video/media/3', type: 'video/mp4', name: 'clip.mp4', duration: 75000 };
  const thumb = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#4a8"/></svg>');
  const answers = {
    checkNotifications: () => ({ permission: 'granted', fullScreen: true, push: false }),
    setSystemBars: () => undefined,
    checkForUpdate: () => ({ supported: false }),
    mediaAccess: () => ({ access }),
    requestMediaAccess: () => { access = 'all'; return { access }; },
    listMedia: ({ offset, limit }) => ({ items: items.slice(offset, offset + limit) }),
    mediaThumbnail: () => ({ url: thumb }),
    openSettings: () => undefined,
  };
  window.__android = { record };
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
    // As Capacitor's native bridge: content:// files through its own server.
    convertFileSrc: (path) => location.origin + path.replace('content:/', '/_capacitor_content_'),
    nativePromise: async (plugin, method, options) => {
      if (method === 'removeListener') return undefined;
      record.calls.push({ method, options: options ?? null });
      if (!answers[method]) return undefined;
      return answers[method](options ?? {});
    },
    nativeCallback: () => `cb-${Math.random()}`,
  };
}

const browser = await launchChrome();
try {
  const bob = await signUp(browser, 'bob');
  const alice = await signUp(browser, 'alice', { ...devices['Pixel 7'] });
  const a = alice.page;

  // ---- Phone web ----
  await openChat(a, bob.id);
  const boxBefore = await a.locator('#dm-chat-form').boundingBox();
  await a.tap('button[aria-label="Add"]');
  const panel = a.locator('.attach-panel');
  await panel.waitFor();
  check(!(await a.$('.composer-add-menu')), 'a phone gets the panel, not the menu');
  const panelBox = await panel.boundingBox();
  const viewport = a.viewportSize();
  check(Math.abs(panelBox.y + panelBox.height - viewport.height) <= 2, `the panel sits at the bottom (${Math.round(panelBox.y)}–${Math.round(panelBox.y + panelBox.height)} of ${viewport.height})`);
  const boxAfter = await a.locator('#dm-chat-form').boundingBox();
  check(boxAfter.y + boxAfter.height <= panelBox.y + 1 && boxAfter.y < boxBefore.y, 'the message box moves up above it');
  const tiles = await a.locator('.attach-panel-grid .attach-tile').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  check(tiles.length === 2, 'phone web: Camera and Photos tiles, no gallery');
  const gridWidth = (await a.locator('.attach-panel-grid').boundingBox()).width;
  check(Math.abs(tiles[0].width - (gridWidth - 4 - 6) / 4) < 2 && Math.abs(tiles[0].width - tiles[0].height) < 1, 'square tiles, four across');
  const bar = await a.locator('.attach-panel-bar button').allTextContents();
  check(bar.join(',') === 'Photos,Poll,Files,Timestamps', `the bar: ${bar.join(', ')} (no Thread in a DM)`);
  check(await a.locator('.attach-panel-bar button:has-text("Poll")').isEnabled(), 'Poll is there in a DM');
  await shot(a, 'phone-web-panel');

  await a.tap('.attach-panel .emoji-picker-handle');
  await a.waitForSelector('.attach-panel.expanded');
  const full = await panel.boundingBox();
  check(full.y <= 1 && full.height >= viewport.height - 2, 'the handle opens it full screen');
  await shot(a, 'phone-web-panel-full');
  await a.tap('.attach-panel .emoji-picker-handle');
  await a.waitForSelector('.attach-panel:not(.expanded)');

  // Files: the file chooser; the chosen file is attached.
  const [chooser] = await Promise.all([a.waitForEvent('filechooser'), a.tap('.attach-panel-bar button:has-text("Files")')]);
  check(chooser.isMultiple(), 'Files opens the file chooser (several files)');
  await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await a.waitForSelector('.attachment-tray >> text=notes.txt');
  check(true, 'the chosen file is attached');
  const [photos] = await Promise.all([a.waitForEvent('filechooser'), a.tap('.attach-panel-bar button:has-text("Photos")')]);
  check(await photos.element().getAttribute('accept') === 'image/*,video/*', 'Photos opens the phone\'s photo picker');
  await photos.setFiles([]);
  const [camera] = await Promise.all([a.waitForEvent('filechooser'), a.tap('.attach-tile:has-text("Camera")')]);
  check(await camera.element().getAttribute('capture') === 'environment', 'Camera takes a photo');
  await camera.setFiles([]);

  // Tapping the message box: the keyboard's turn, the panel goes.
  await a.tap('#dm-input');
  await a.waitForSelector('.attach-panel', { state: 'detached' });
  check(true, 'tapping the message box closes the panel');
  await a.tap('button.send-button');
  await bob.page.goto(`${BASE}/dm/${alice.id}`);
  await bob.page.waitForSelector('text=notes.txt', { timeout: 20000 });
  check(true, 'Bob gets the file');

  // Poll from the panel.
  await a.tap('button[aria-label="Add"]');
  await a.tap('.attach-panel-bar button:has-text("Poll")');
  await a.waitForSelector('.vc-dialog');
  check(!(await a.$('.attach-panel')), 'Poll opens the poll dialog in the panel\'s place');
  await a.keyboard.press('Escape');

  // ---- The Android app ----
  await a.context().addInitScript(fakeAndroid);
  const read = [];
  await a.route('**/_capacitor_content_/**', (route) => {
    read.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('#dm-input');
  await a.tap('button[aria-label="Add"]');
  await a.waitForSelector('.attach-panel-ask');
  check(await a.locator('.attach-panel-ask').isVisible(), 'the app asks before showing photos');
  await shot(a, 'android-ask');
  await a.tap('button:has-text("Allow access")');
  await a.waitForSelector('.attach-media img');
  const media = await a.locator('.attach-media').count();
  check(media === 10, `then shows the phone's photos (${media})`);
  check(await a.locator('.attach-tile').first().textContent() === 'Camera', 'after the camera tile');
  check((await a.locator('.attach-media[aria-label="clip.mp4"]').textContent()).includes('1:15'), 'videos show their length');
  await a.tap('.attach-media[aria-label="photo2.png"]');
  await a.waitForSelector('.attach-media[aria-label="photo2.png"].picked');
  await a.tap('.attach-media[aria-label="photo1.png"]');
  await a.waitForSelector('.attach-media[aria-label="photo1.png"].picked');
  check(await a.textContent('.attach-media[aria-label="photo2.png"] .attach-media-check') === '1'
    && await a.textContent('.attach-media[aria-label="photo1.png"] .attach-media-check') === '2', 'picked photos are numbered in order');
  check(await a.locator('.attachment-tray .attachment-tray-item, .attachment-tray > *').count() >= 2, 'and attached');
  check(read.length === 2, `only the picked files are read (${read.length})`);
  await shot(a, 'android-picked');
  await a.tap('.attach-media[aria-label="photo2.png"]');
  await a.waitForSelector('.attach-media[aria-label="photo2.png"]:not(.picked)');
  check(await a.textContent('.attach-media[aria-label="photo1.png"] .attach-media-check') === '1', 'tapping again takes it back; the other becomes 1');
  await a.tap('button.send-button');
  await bob.page.waitForFunction(() => document.querySelectorAll('.dm-message img, [data-msg-id] img.attachment-image, [data-msg-id] img').length > 0, null, { timeout: 20000 });
  check(true, 'Bob sees the picture');

  // ---- Guild channel: Create thread ----
  const guild = await api(bob.page, 'POST', '/guilds', { name: 'Panel' });
  const general = guild.channels[0];
  const invite = await api(bob.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(a, 'POST', `/invites/${invite.code}`);
  const b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  await b.click('button[aria-label="Add"]');
  await b.click('.composer-add-menu >> text=Create thread');
  await b.waitForSelector('#thread-name');
  check(await b.inputValue('#thread-name') === '', 'a computer\'s + menu starts a thread on its own');
  await shot(b, 'desktop-menu-thread');
  await b.fill('#thread-name', 'From the plus');
  await b.click('.vc-dialog >> button:has-text("Create thread")');
  await b.waitForSelector('.thread-pane-title h5:text-is("From the plus")');
  check(true, 'and opens it');

  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await a.tap('button[aria-label="Add"]');
  const guildBar = await a.locator('.attach-panel-bar button').allTextContents();
  check(guildBar.join(',') === 'Photos,Poll,Thread,Files,Timestamps', `a guild channel's bar: ${guildBar.join(', ')}`);
  check(await a.locator('.attach-panel-bar').evaluate((el) => el.scrollWidth <= el.clientWidth
    && [...el.querySelectorAll('span')].every((s) => s.scrollWidth <= s.parentElement.clientWidth)), 'all five fit the phone');
  await shot(a, 'phone-guild-panel');
  await a.tap('.attach-panel-bar button:has-text("Thread")');
  await a.waitForSelector('#thread-name');
  check(!(await a.$('.attach-panel')), 'the panel\'s Thread opens the new thread dialog');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
