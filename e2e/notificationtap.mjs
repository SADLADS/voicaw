// Tapping a notification opens its chat, wherever the app was: the Android app (a phone, a
// stand-in Capacitor bridge that holds an event until the page listens and really removes
// listeners, as Capacitor's Plugin.java does) and the desktop app (a stand-in for preload.js).
// From another DM, from a guild channel, from the list, into a thread, and an app started by
// the tap (the event waiting for the page).
//   node e2e/serve.mjs &   then   node e2e/notificationtap.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// What Capacitor's native side would be, for the Voicaw plugin's `navigate` event.
function fakeAndroid() {
  const listeners = {}; // eventName -> Map(callbackId -> callback)
  const retained = {}; // eventName -> [data], until a first listener (retainUntilConsumed)
  const answers = {
    checkNotifications: () => ({ permission: 'prompt', fullScreen: true, push: true }),
    checkForUpdate: () => ({ supported: false }),
    setOngoing: () => undefined,
    clearOngoing: () => undefined,
    stopRinging: () => undefined,
  };
  const emit = (event, data) => {
    const now = [...(listeners[event]?.values() ?? [])];
    if (!now.length) (retained[event] ??= []).push(data);
    for (const callback of now) callback(data);
  };
  window.__android = {
    emit,
    listening: (event) => listeners[event]?.size ?? 0,
  };
  // An app started by a tapped notification: the event is there before the page.
  const pending = sessionStorage.getItem('fakeAndroidLaunch');
  if (pending) {
    sessionStorage.removeItem('fakeAndroidLaunch');
    emit('navigate', { url: pending });
  }
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
    nativePromise: async (plugin, method, options) => {
      if (method === 'removeListener') {
        listeners[options.eventName]?.delete(options.callbackId);
        return undefined;
      }
      return answers[method]?.(options);
    },
    nativeCallback: (plugin, method, options, callback) => {
      const id = `cb-${Math.random()}`;
      const map = (listeners[options.eventName] ??= new Map());
      const first = map.size === 0;
      map.set(id, callback);
      if (first && retained[options.eventName]) {
        const waiting = retained[options.eventName];
        delete retained[options.eventName];
        setTimeout(() => waiting.forEach((data) => callback(data)), 0);
      }
      return id;
    },
  };
}

// What electron/preload.js gives the page.
function fakeDesktop() {
  const handlers = {};
  const on = (event) => (callback) => {
    (handlers[event] ??= new Set()).add(callback);
    return () => handlers[event].delete(callback);
  };
  window.__desktop = { emit: (event, data) => (handlers[event] ?? []).forEach((cb) => cb(data)) };
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify() {},
    setUnread() {},
    getSettings: async () => ({ shortcuts: {} }),
    updateSettings: async () => ({ settings: { shortcuts: {} }, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: () => new Promise(() => {}),
    onNavigate: on('navigate'),
    onShortcut: on('shortcut'),
    onUpdateReady: on('updateReady'),
    onUpdateProgress: on('updateProgress'),
  };
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json().catch(() => null);
}, [method, path, body]);

const paneShowing = (page) => page.evaluate(() => {
  const wrapper = document.querySelector('.pane-content, .pane-list');
  return wrapper?.classList.contains('pane-content') ? 'chat' : wrapper ? 'list' : 'none';
});
const path = (page) => page.evaluate(() => window.location.pathname + window.location.search);

const browser = await launchChrome();
try {
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const alice = await signUp(browser, 'alice', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob, carol);
  const page = alice.page;
  const guild = await api(page, 'POST', '/guilds', { name: 'Tap Guild' });
  const guildId = guild.id ?? guild.guild?.id;
  const layout = await api(page, 'GET', `/guilds/${guildId}`);
  const channelId = (layout.channels ?? layout.guild?.channels).find((c) => c.type === 'text').id;

  // The Android app.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.context().addInitScript(fakeAndroid);

  const tap = async (url, label) => {
    await page.waitForFunction(() => window.__android.listening('navigate') > 0);
    await page.evaluate((u) => window.__android.emit('navigate', { url: u }), url);
    await page.waitForTimeout(800);
    const at = await path(page);
    const pane = await paneShowing(page);
    check(at === url && pane === 'chat', `phone: ${label} (at ${at}, ${pane})`);
    if (dir) await page.screenshot({ path: `${dir}/${label.replace(/\W+/g, '-')}.png` });
  };

  await page.goto(`${BASE}/dm/${bob.id}`);
  await page.waitForSelector('#dm-input');
  await page.waitForTimeout(500);
  await tap(`/dm/${carol.id}`, 'from a DM, a notification for another DM');
  await tap(`/guild/${guildId}/${channelId}`, 'from a DM, a guild mention');
  await tap(`/dm/${bob.id}`, 'from a guild channel, a DM');
  await page.click('.pane-back-button');
  await page.waitForTimeout(600);
  check(await paneShowing(page) === 'list', 'phone: back shows the list');
  await tap(`/dm/${carol.id}`, 'from the list, a DM');
  await tap(`/dm/${carol.id}`, 'the chat already open, its own notification');
  await page.goto(`${BASE}/settings`);
  await page.waitForTimeout(500);
  await tap(`/dm/${bob.id}`, 'from Settings, a DM');

  // Started by the tap: Android has the event before the page listens.
  await page.evaluate((u) => sessionStorage.setItem('fakeAndroidLaunch', u), `/dm/${carol.id}`);
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(2500);
  const at = await path(page);
  const pane = await paneShowing(page);
  check(at === `/dm/${carol.id}` && pane === 'chat', `phone: an app started by the tap opens its chat, not the latest one (at ${at}, ${pane})`);

  // The desktop app.
  const desk = bob.page;
  await desk.context().addInitScript(fakeDesktop);
  await desk.goto(`${BASE}/dm/${carol.id}`);
  await desk.waitForSelector('#dm-input');
  await desk.waitForTimeout(500);
  for (const [url, label] of [[`/dm/${alice.id}`, 'another DM'], [`/dm/${carol.id}`, 'back to the first']]) {
    await desk.evaluate((u) => window.__desktop.emit('navigate', u), url);
    await desk.waitForTimeout(500);
    const now = await path(desk);
    check(now === url, `desktop: ${label} (at ${now})`);
  }
} finally {
  await browser.close();
}
console.log(failures ? `notificationtap: ${failures} failed` : 'notificationtap: ok');
process.exit(failures ? 1 : 0);
