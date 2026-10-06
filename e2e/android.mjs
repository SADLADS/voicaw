// The Android app's page side (Android itself can't run here): a stand-in for the native side
// of Capacitor (window.androidBridge, the Voicaw plugin's headers, nativePromise/nativeCallback),
// as mobile/android/.../VoicawPlugin.java answers them, records what the page asks. Checks:
// no service worker, Settings → Android App, turning notifications on registers the phone's
// Firebase token and key, a new version offered and downloaded on Update, tapping a
// notification opens its chat, the hidden notification page
// (notify.html) decrypts a real DM preview with the app's own storage, and a call: Answer from
// the notification answers it, the ongoing-call
// notification follows it (name, mute), and its Hang up ends the call.
//   node e2e/serve.mjs &   then   node e2e/android.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, devices, fakeMicArgs, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Runs in the page before the app: what Capacitor's native bridge would be.
function fakeAndroid() {
  const record = { calls: [] };
  const listeners = {};
  // Android remembers what was allowed across reloads.
  let state = JSON.parse(sessionStorage.getItem('fakeAndroid') || 'null') ?? { permission: 'prompt', fullScreen: false, push: true };
  const save = () => sessionStorage.setItem('fakeAndroid', JSON.stringify(state));
  const answers = {
    checkNotifications: () => state,
    requestNotifications: () => {
      state = { ...state, permission: 'granted' };
      save();
      return state;
    },
    getPushToken: () => ({ token: 'e2e-phone-token', key: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) }),
    setOngoing: () => undefined,
    clearOngoing: () => undefined,
    stopRinging: () => undefined,
    getPushLog: () => ({ entries: [{ at: Date.now(), type: 'test', outcome: 'shown' }] }),
    openSettings: () => undefined,
    // updates.voicaw.com has a newer version (AppUpdater, the `direct` build).
    checkForUpdate: () => ({ supported: true, current: '0.1.4', available: true, version: '0.1.5', size: 25 * 1024 * 1024 }),
    installUpdate: () => {
      (listeners.updateProgress ?? []).forEach((cb) => cb({ received: 10, total: 40 }));
      return new Promise(() => {}); // still downloading
    },
  };
  window.__android = {
    record,
    emit: (event, data) => (listeners[event] ?? []).forEach((cb) => cb(data)),
    allowFullScreen: () => { state = { ...state, fullScreen: true }; save(); },
  };
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
      if (method === 'removeListener') return undefined;
      record.calls.push({ method, options: options ?? null });
      return answers[method](options);
    },
    nativeCallback: (plugin, method, options, callback) => {
      (listeners[options.eventName] ??= []).push(callback);
      return `cb-${Math.random()}`;
    },
  };
}

const callsTo = (page, method) => page.evaluate((m) => window.__android.record.calls.filter((c) => c.method === m), method);

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const bob = await signUp(browser, 'bob');
  // Alice is the Android app (a phone): the bridge exists from the next page load on.
  const alice = await signUp(browser, 'alice', { ...devices['Pixel 7'] });
  const page = alice.page;
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404/.test(m.text())) console.log('[alice error]', m.text().slice(0, 200));
  });
  page.on('response', (r) => {
    if (r.status() === 403) console.log('[alice] 403 from', r.url());
  });
  // signUp ran as a browser, which registered the web app's service worker; the app never has.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.context().addInitScript(fakeAndroid);
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('#dm-main');

  check(await page.evaluate(() => window.Capacitor.getPlatform?.() ?? 'android') === 'android', 'the page sees Android');
  check(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0) === 0,
    'no service worker in the Android app');
  check((await callsTo(page, 'checkNotifications')).length > 0, "asks the app about notifications at start");

  // A newer version: offered, downloaded only on Update.
  await page.waitForSelector('.update-banner:has-text("Voicaw 0.1.5 · 25 MB")');
  check((await callsTo(page, 'installUpdate')).length === 0, 'offers the new version without downloading it');
  if (dir) await page.screenshot({ path: `${dir}/android-update.png` });
  await page.click('.update-banner-button');
  await page.waitForSelector('.update-banner:has-text("Downloading… 25%")');
  check(await page.isDisabled('.update-banner-button'), 'Update downloads it, showing how far it is');
  if (dir) await page.screenshot({ path: `${dir}/android-update-downloading.png` });
  await page.evaluate(() => window.__android.emit('updateResult', { status: 'aborted' }));
  await page.waitForSelector('.update-banner-button:not([disabled])');
  check(true, 'cancelled at Android\'s question: offered again');
  await page.click('.update-banner-close');

  // Settings: the Android App section, and notifications turned on.
  await page.goto(`${BASE}/settings`);
  await page.click('text=Android app');
  await page.waitForSelector('h5:text-is("Android App")');
  check(await page.isVisible('button:text-is("Allow full-screen calls")'), 'offers to allow full-screen calls when Android says no');
  await page.click('button:text-is("Allow full-screen calls")');
  check((await callsTo(page, 'openSettings')).some((c) => c.options.which === 'fullScreen'), "opens Android's full-screen setting");
  await page.evaluate(() => window.__android.allowFullScreen());
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('text=Incoming calls ring full screen');
  check(true, 'reads the setting again on return');
  check(await page.isVisible('.android-push-log li:has-text("test: shown")'), 'lists what became of recent notifications');
  if (dir) await page.screenshot({ path: `${dir}/android-settings.png` });

  await page.click('text=Notifications');
  const enable = page.locator('button:has-text("Turn on"), button:has-text("Enable")').first();
  await enable.click();
  await page.waitForFunction(() => window.__android.record.calls.some((c) => c.method === 'getPushToken'));
  const devicesNow = await page.evaluate(async () => {
    const res = await fetch('/api/test-push', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return res.json();
  });
  check((await callsTo(page, 'requestNotifications')).length === 1, "asks Android's permission");
  check(devicesNow.devices >= 1, `the server has the phone's registration (${devicesNow.devices} device)`);

  // A notification tapped: the app is told where to go, and shows that chat, not the list.
  const paneShowing = () => page.evaluate(() => {
    const wrapper = document.querySelector('.pane-content, .pane-list');
    return wrapper?.classList.contains('pane-content') ? 'chat' : wrapper ? 'list' : 'none';
  });
  await page.evaluate((id) => window.__android.emit('navigate', { url: `/dm/${id}` }), bob.id);
  await page.waitForURL(`**/dm/${bob.id}`);
  await page.waitForTimeout(300);
  check(await paneShowing() === 'chat', 'tapping a notification over Settings opens its chat');
  if (dir) await page.screenshot({ path: `${dir}/android-tap-over-settings.png` });
  if (await page.isVisible('.update-banner-close')) await page.click('.update-banner-close');
  await page.click('.pane-back-button');
  await page.waitForTimeout(600);
  check(await paneShowing() === 'list', 'back from it shows the list');
  await page.evaluate(() => window.__android.emit('navigate', { url: '/dm/notes' }));
  await page.waitForURL('**/dm/notes');
  await page.waitForTimeout(600);
  check(await paneShowing() === 'chat', 'tapping a notification while the list shows opens its chat');
  if (dir) await page.screenshot({ path: `${dir}/android-tap-over-list.png` });
  await page.evaluate((id) => window.__android.emit('navigate', { url: `/dm/${id}` }), bob.id);
  await page.waitForURL(`**/dm/${bob.id}`);
  await page.reload();
  await page.waitForSelector('#dm-input');
  await page.waitForTimeout(500);
  check(!(await page.isVisible('text=Get notified when you receive a message')), 'no "turn on notifications" prompt once they are on');

  // The hidden page words a real DM: decrypted with the keys this app keeps.
  await openChat(bob.page, alice.id);
  await send(bob.page, 'Secret plans for Saturday');
  await page.waitForSelector('text=Secret plans for Saturday');
  const ciphertext = await page.evaluate(async (id) => {
    const res = await fetch(`/api/dm-messages/${id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : body.messages;
    return rows.find((m) => m.sender_id === id).content;
  }, bob.id);
  check(!ciphertext.includes('Secret'), 'the server only has ciphertext');
  const notify = await page.context().newPage();
  await notify.addInitScript(() => {
    window.__results = {};
    window.VoicawNotifyHost = { ready() { window.__ready = true; }, result(id, json) { window.__results[id] = JSON.parse(json); } };
  });
  await notify.goto(`${BASE}/notify.html`);
  await notify.waitForFunction(() => window.__ready);
  const payload = { type: 'dm', title: bob.name, body: 'New message', url: `/dm/${bob.id}`, tag: `dm-${bob.id}`, senderId: bob.id, recipientId: alice.id, recipientName: alice.name, ciphertext };
  await notify.evaluate((p) => window.voicawNotify.run(1, { type: 'render', payload: p }), payload);
  const rendered = await notify.evaluate(() => window.__results[1]);
  check(rendered?.ok && rendered.body === 'Secret plans for Saturday', `the hidden page decrypts the preview ("${rendered?.body}")`);
  check(rendered?.title === bob.name && rendered.url === `/dm/${bob.id}` && rendered.labels?.answer === 'Accept', 'with its title, link and button labels');
  await notify.close();

  // A call: Bob calls; Alice's phone rings natively (the page stays quiet), she answers from
  // the notification.
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('#dm-main');
  await bob.page.click(`button[aria-label="Call ${alice.name}"]:not([disabled])`);
  await page.waitForSelector('.incoming-call');
  const callId = await page.evaluate(async () => {
    const res = await fetch('/api/dm-calls/current', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).id;
  });
  await page.evaluate((id) => window.__android.emit('callAction', { action: 'answer', callId: id }), callId);
  await page.waitForFunction(
    () => window.__android.record.calls.some((c) => c.method === 'setOngoing' && /Call Connected/.test(c.options.text)),
    null, { timeout: 20000 });
  await bob.page.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  check(true, 'Answer on the notification answers the call');
  check((await callsTo(page, 'stopRinging')).some((c) => c.options.callId === callId), 'the phone is told to stop ringing');
  const ongoing = (await callsTo(page, 'setOngoing')).at(-1).options;
  check(ongoing.title === `Call with ${bob.name}` && ongoing.inCall && !ongoing.muted && ongoing.labels.hangUp === 'Hang up',
    `the ongoing-call notification shows the call (${ongoing.title} · ${ongoing.text})`);

  await page.evaluate(() => window.__android.emit('callAction', { action: 'mute' }));
  await page.waitForFunction(() => window.__android.record.calls.filter((c) => c.method === 'setOngoing').at(-1).options.muted);
  check(true, 'Mute on the notification mutes, and the notification follows');
  if (dir) await page.screenshot({ path: `${dir}/android-in-call.png` });

  await page.evaluate(() => window.__android.emit('callAction', { action: 'hangUp' }));
  await bob.page.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });
  await page.waitForFunction(() => window.__android.record.calls.some((c) => c.method === 'clearOngoing'));
  check(true, 'Hang up on the notification ends the call for both, and the notification goes');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'OK');
process.exit(failures ? 1 : 0);
