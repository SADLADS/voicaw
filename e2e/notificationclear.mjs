// Reading a chat takes its notification down on the reader's other devices: Bob is logged in
// twice, as the desktop app (a stand-in bridge, as desktop.mjs) and in a browser. Alice's DM
// notifies the desktop app; Bob opening it in the browser makes the desktop app close it
// (`closeNotification`), and the browser closes its own notification for that chat too (the
// service worker's, made up here: headless Chrome gets no real web push). Reading again
// closes nothing; a chat that was never notified closes nothing.
//   node e2e/serve.mjs &   then   node e2e/notificationclear.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Runs in the desktop page before the app: the bridge, recording notifications and closes.
function fakeBridge() {
  const record = { notifications: [], closed: [] };
  window.__desktop = { record };
  const on = () => () => () => {};
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: (n) => record.notifications.push(n),
    closeNotification: (tag) => record.closed.push(tag),
    setUnread: () => {},
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, autoUpdate: true, shortcuts: {} }),
    updateSettings: async (changes) => ({ settings: changes, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: async () => false,
    onNavigate: on(),
    onShortcut: on(),
    onUpdateReady: on(),
    onUpdateProgress: on(),
  };
}

const waitFor = async (fn, timeoutMs = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const web = bob.page;
  await web.context().grantPermissions(['notifications'], { origin: BASE });

  const desktopContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await desktopContext.addInitScript(fakeBridge);
  const desktop = await desktopContext.newPage();
  desktop.on('pageerror', (e) => console.log('[bob desktop] page error:', e.message));
  await desktop.goto(`${BASE}/`);
  await desktop.fill('input[placeholder="Username"]', bob.name);
  await desktop.fill('input[placeholder="Password"]', bob.password);
  await desktop.press('input[placeholder="Password"]', 'Enter');
  await desktop.waitForSelector('#dm-main', { timeout: 20000 });
  const record = () => desktop.evaluate(() => window.__desktop.record);

  // Neither of Bob's devices is looking at Alice's chat.
  await desktop.goto(`${BASE}/settings`);
  await web.goto(`${BASE}/settings`);
  await desktop.waitForTimeout(1000);

  await openChat(alice.page, bob.id);
  await send(alice.page, 'read me somewhere');
  const tag = `dm-${alice.id}`;
  check(await waitFor(async () => (await record()).notifications.some((n) => n.tag === tag)),
    `the desktop app shows Alice's message (${tag})`);
  check((await record()).closed.length === 0, 'nothing closed yet');

  // The browser's own notification for the chat (as its service worker would show a push).
  const swReady = await web.evaluate(async (t) => {
    const registration = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 5000))]);
    if (!registration) return false;
    await registration.showNotification('Alice', { body: 'read me somewhere', tag: t });
    await registration.showNotification('Someone else', { tag: 'dm-999999' });
    return (await registration.getNotifications({ tag: t })).length === 1;
  }, tag);
  check(swReady, 'the browser shows a notification for the chat (service worker)');

  // Bob reads it in the browser.
  await openChat(web, alice.id);
  await web.waitForSelector('text=read me somewhere');
  check(await waitFor(async () => (await record()).closed.includes(tag)), 'the desktop app closes its notification');
  if (swReady) {
    const left = await web.evaluate(async (t) => {
      const registration = await navigator.serviceWorker.ready;
      return { chat: (await registration.getNotifications({ tag: t })).length, other: (await registration.getNotifications({ tag: 'dm-999999' })).length };
    }, tag);
    check(left.chat === 0, "the browser closes its own notification for the open chat");
    check(left.other === 1, "another chat's notification stays");
  }
  if (dir) await web.screenshot({ path: `${dir}/read-in-browser.png` });

  // Reading again (going away and back) sends nothing new: nothing was notified since.
  await web.goto(`${BASE}/settings`);
  await openChat(web, alice.id);
  await web.waitForTimeout(1500);
  check((await record()).closed.filter((t) => t === tag).length === 1, 'reading again closes nothing more');

  // A second message, read on the desktop app itself: closed there too (its own read).
  await web.goto(`${BASE}/settings`);
  await send(alice.page, 'and again');
  check(await waitFor(async () => (await record()).notifications.filter((n) => n.tag === tag).length === 2), 'the second message notifies');
  await openChat(desktop, alice.id);
  check(await waitFor(async () => (await record()).closed.filter((t) => t === tag).length >= 2), 'reading it on the desktop app closes it there');
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
