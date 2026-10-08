// The desktop app's page side (Electron itself can't run here): a stand-in for its bridge
// (electron/preload.js) records what the page asks of it. Notifications arrive over the
// websocket and are decrypted into the preview, the unread badge, clicking a notification,
// the mute shortcut, Settings → Desktop App, turning notifications off, no service worker,
// updating (a last look for a newer version, its download's progress, a failed one).
//   node e2e/serve.mjs &   then   node e2e/desktop.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Runs in the page before the app: the bridge, recording calls, with hooks to play the app's part.
function fakeBridge() {
  const record = { notifications: [], unread: [], settingsChanges: [] };
  const listeners = {};
  let settings = { closeToTray: true, startAtLogin: false, shortcuts: { toggleMute: null, toggleDeafen: null } };
  let finishInstall = () => {};
  window.__desktop = {
    record,
    emit: (name, value) => listeners[name]?.(value),
    finishInstall: (ok) => finishInstall(ok),
  };
  const on = (name) => (cb) => { listeners[name] = cb; return () => {}; };
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: (n) => record.notifications.push(n),
    setUnread: (u) => record.unread.push(u),
    getSettings: async () => settings,
    updateSettings: async (changes) => {
      record.settingsChanges.push(changes);
      settings = { ...settings, ...changes, shortcuts: { ...settings.shortcuts, ...changes.shortcuts } };
      return { settings, failedShortcuts: [] };
    },
    checkForUpdates: async () => 'unsupported',
    installUpdate: () => {
      record.installs = (record.installs ?? 0) + 1;
      return new Promise((resolve) => { finishInstall = resolve; });
    },
    onNavigate: on('navigate'),
    onShortcut: on('shortcut'),
    onUpdateReady: on('updateReady'),
    onUpdateProgress: on('updateProgress'),
  };
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  // Bob is the desktop app: the bridge exists from the first page load.
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await bobContext.addInitScript(fakeBridge);
  const bob = await signUp(browser, 'bob', undefined).then(async (b) => {
    // signUp made its own context; log the same account in to the desktop one.
    const page = await bobContext.newPage();
    page.on('pageerror', (e) => console.log('[bob desktop] page error:', e.message));
    await page.goto(`${BASE}/`);
    await page.fill('input[placeholder="Username"]', b.name);
    await page.fill('input[placeholder="Password"]', b.password);
    await page.press('input[placeholder="Password"]', 'Enter');
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await b.page.context().close();
    return { ...b, page };
  });
  const page = bob.page;
  const record = () => page.evaluate(() => window.__desktop.record);

  check(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0) === 0,
    'no service worker in the desktop app');

  // Bob opens Alice's chat once (so this device has checked her keys), then goes elsewhere.
  await openChat(page, alice.id);
  await page.goto(`${BASE}/settings`);
  await page.click('.settings-nav-item:text-is("Desktop App")');
  await page.waitForSelector('h5:text-is("Desktop App")');
  check(true, 'Settings has a Desktop App page');
  const card = page.locator('.settings-card:has(h5:text-is("Desktop App"))');
  await card.locator('button[aria-label="Toggle mute shortcut"]').click();
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('button[aria-label="Toggle mute shortcut"]:text-is("Ctrl + Shift + M")');
  check(true, 'a shortcut is recorded from a key press');
  if (dir) await card.screenshot({ path: `${dir}/desktop-settings.png` });
  await page.waitForTimeout(500); // presence reaches the server

  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello **desktop**');
  await page.waitForFunction(() => window.__desktop.record.notifications.length > 0, null, { timeout: 10000 });
  const [n] = (await record()).notifications;
  check(n.body === 'hello **desktop**' && n.url === `/dm/${alice.id}`, `notification with the decrypted text (${JSON.stringify(n.body)})`);
  check(n.title === alice.name && n.tag === `dm-${alice.id}`, 'titled by the sender, one per chat');
  check(typeof n.icon === 'string' && n.icon.startsWith('data:image/'), 'with a picture');

  await page.waitForFunction(() => window.__desktop.record.unread.at(-1)?.count === 1);
  check(true, 'the badge counts the unread message');

  // Clicking the notification: the app opens the chat, and it's read.
  await page.evaluate((url) => window.__desktop.emit('navigate', url), n.url);
  await page.waitForURL(`**/dm/${alice.id}`);
  await page.waitForFunction(() => window.__desktop.record.unread.at(-1)?.count === 0, null, { timeout: 10000 });
  check(true, 'clicking it opens the chat and the badge clears');

  // Alice is not the desktop app: no section, nothing recorded.
  await alice.page.goto(`${BASE}/settings`);
  await alice.page.waitForSelector('text=Notifications');
  check(await alice.page.locator('.settings-nav-item:text-is("Desktop App")').count() === 0, 'no Desktop App page in a browser');

  // The mute shortcut.
  const muteButton = page.locator('.user-panel button[aria-label="Mute"], .user-panel button[aria-label="Unmute"]').first();
  await page.evaluate(() => window.__desktop.emit('shortcut', 'toggleMute'));
  await page.waitForSelector('.user-panel button[aria-label="Unmute"]');
  check(await muteButton.getAttribute('aria-pressed') === 'true', 'the mute shortcut mutes');
  await page.evaluate(() => window.__desktop.emit('shortcut', 'toggleMute'));
  await page.waitForSelector('.user-panel button[aria-label="Mute"]');
  check(true, 'and unmutes');

  // Updating: "Update" looks for a newer version first, shows a newer one downloading, and
  // offers it again if that fails (the app restarts otherwise).
  await page.evaluate(() => window.__desktop.emit('updateReady', '0.2.0'));
  await page.waitForSelector('.update-banner:has-text("A new version is ready.")');
  await page.evaluate(() => window.__desktop.emit('updateProgress', 0.3));
  check(await page.locator('.update-banner:has-text("Downloading")').count() === 0, 'a background download shows nothing');
  await page.click('.update-banner-button');
  await page.waitForSelector('.update-banner:has-text("Looking for a newer version…")');
  check(await page.isDisabled('.update-banner-button') && (await record()).installs === 1, 'Update looks for a newer version first');
  await page.evaluate(() => window.__desktop.emit('updateProgress', 0.42));
  await page.waitForSelector('.update-banner:has-text("Downloading… 42%")');
  if (dir) await page.screenshot({ path: `${dir}/update-downloading.png` });
  await page.evaluate(() => window.__desktop.emit('updateReady', '0.2.1'));
  check(await page.locator('.update-banner:has-text("Downloading… 42%")').count() === 1, 'a newer version downloading shows its progress');
  await page.evaluate(() => window.__desktop.finishInstall(false));
  await page.waitForSelector('.update-banner:has-text("Couldn\'t download the update")');
  check(!(await page.isDisabled('.update-banner-button')), 'a failed download offers Update again');
  await page.click('.update-banner-close');

  // Notifications off: none come.
  await page.goto(`${BASE}/settings/notifications`);
  await page.click('button:has-text("Turn off")');
  await page.waitForSelector('text=Notifications are off for this device.');
  await page.waitForTimeout(500);
  const before = (await record()).notifications.length;
  await alice.page.goto(`${BASE}/dm/${bob.id}`);
  await alice.page.waitForSelector('#dm-input');
  await send(alice.page, 'while off');
  await page.waitForTimeout(1500);
  check((await record()).notifications.length === before, 'turned off: no notifications');

  console.log(failures ? `desktop: ${failures} FAILED` : 'desktop: ok');
  if (failures) process.exitCode = 1;
} catch (err) {
  console.error('desktop: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
