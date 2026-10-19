// The in-game overlay (electron/overlay.js) in the real desktop app under Xvfb: Bob's app, with
// a stand-in Steam library in its home folder, in a voice channel with Alice (Chrome, a fake
// microphone talking). No overlay until a game runs: a stand-in Steam game (a process with
// SteamAppId in its environment, found among the running programs, no Rich Presence) brings it
// up, top left, the size of its content, listing both with Alice's ring lit while she talks;
// Alice's DM shows there as a toast. The shortcut (Ctrl+Shift+O, pressed through XTest) unlocks
// it over the whole screen: Mute mutes Bob's app, a corner moves it, Escape locks it again
// (now bottom right). The game quitting takes it away; Settings → Desktop App's overlay off
// keeps it away.
//   node e2e/serve.mjs &   (the client built for the desktop app against it first: README,
//   "The real desktop app")   then   node e2e/overlay.mjs [screenshot dir]
// E2E_OVERLAY_DISPLAY (:87) and E2E_OVERLAY_CDP_PORT (9347) if those are taken. Needs libXtst.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { spawn, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { BASE, launchChrome, signUp, makeFriends, openChat, send, fakeMicArgs } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
async function until(test, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(test).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

if (!existsSync(join(root, 'build', 'overlay.html'))) {
  console.log('Build the client for the desktop app first (see the top of this file).');
  process.exit(1);
}

const SCREEN = { width: 1400, height: 900 };
const scratch = mkdtempSync(join(tmpdir(), 'voicaw-overlay-'));
const home = join(scratch, 'home');
const steam = join(home, '.local', 'share', 'Steam');
mkdirSync(join(steam, 'steamapps'), { recursive: true });
writeFileSync(join(steam, 'steamapps', 'appmanifest_367520.acf'),
  '"AppState"\n{\n\t"appid"\t\t"367520"\n\t"name"\t\t"Hollow Knight"\n\t"installdir"\t\t"Hollow Knight"\n}\n');

// A key press on the X server, as a person's (XTest), so the app's global shortcut hears it.
const pressKeys = join(scratch, 'press.py');
writeFileSync(pressKeys, `
import ctypes, sys
x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XStringToKeysym.restype = ctypes.c_ulong
d = ctypes.c_void_p(x11.XOpenDisplay(sys.argv[1].encode()))
codes = [x11.XKeysymToKeycode(d, ctypes.c_ulong(x11.XStringToKeysym(k.encode()))) for k in sys.argv[2:]]
for c in codes: xtst.XTestFakeKeyEvent(d, c, 1, 0)
for c in reversed(codes): xtst.XTestFakeKeyEvent(d, c, 0, 0)
x11.XFlush(d); x11.XCloseDisplay(d)
`);
const display = process.env.E2E_OVERLAY_DISPLAY || ':87';
const cdpPort = process.env.E2E_OVERLAY_CDP_PORT || '9347';
const press = (...keys) => execFileSync('python3', [pressKeys, display, ...keys]);

// The game: any program Steam started (SteamAppId in its environment).
let game = null;
const startGame = () => {
  game = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { PATH: process.env.PATH, SteamAppId: '367520' }, stdio: 'ignore' });
};

const xvfb = spawn('Xvfb', [display, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`], { stdio: 'ignore' });
let electron = null;
const browser = await launchChrome({ args: fakeMicArgs({ phrases: true }) });
try {
  const alice = await signUp(browser, 'alice');
  const bobWeb = await signUp(browser, 'bob');
  await makeFriends(alice, bobWeb);
  const a = alice.page;

  // Alice's guild with a voice channel, Bob invited.
  const { guildId, channelId } = await a.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const guild = await (await fetch('/api/guilds', { method: 'POST', headers, body: JSON.stringify({ name: 'Gamers' }) })).json();
    const channel = await (await fetch(`/api/guilds/${guild.id}/channels`, { method: 'POST', headers, body: JSON.stringify({ name: 'lounge', type: 'voice' }) })).json();
    const invite = await (await fetch(`/api/guilds/${guild.id}/invites`, { method: 'POST', headers })).json();
    window.__invite = invite.code;
    return { guildId: guild.id, channelId: channel.id };
  });
  const code = await a.evaluate(() => window.__invite);
  await bobWeb.page.evaluate(async (c) => {
    await fetch(`/api/invites/${c}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  }, code);
  await bobWeb.page.context().close();

  // Bob's desktop app (a fake microphone too, so he's not left muted for want of one).
  electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [join(root, 'electron/main.js'), '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    { env: { ...process.env, DISPLAY: display, HOME: home, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_RUNTIME_DIR: join(scratch, 'run') }, stdio: 'ignore' });
  mkdirSync(join(scratch, 'run'), { recursive: true, mode: 0o700 });
  let app = null;
  const pages = () => app.contexts().flatMap((c) => c.pages());
  await until(async () => {
    app ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    return pages().some((p) => p.url().startsWith('voicaw://app/'));
  }, 30000);
  const bob = pages().find((p) => p.url().startsWith('voicaw://app/'));
  bob.on('pageerror', (e) => console.log('[bob app] page error:', e.message));
  await bob.waitForSelector('input[placeholder="Username"]', { timeout: 30000 });
  await bob.fill('input[placeholder="Username"]', bobWeb.name);
  await bob.fill('input[placeholder="Password"]', bobWeb.password);
  await bob.press('input[placeholder="Password"]', 'Enter');
  await bob.waitForSelector('#dm-main', { timeout: 30000 });

  // Both in the voice channel.
  await a.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await bob.goto(`voicaw://app/guild/${guildId}/${channelId}`);
  await bob.click('.voice-view-join');
  await bob.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });

  const overlayPage = () => pages().find((p) => p.url().endsWith('/overlay.html'));
  await sleep(3000);
  check(!overlayPage(), 'in voice without a game: no overlay');

  // A game starts: found among the running programs within the 15 s between looks.
  startGame();
  check(await until(() => Boolean(overlayPage()), 25000), 'a Steam game running: the overlay appears');
  const overlay = overlayPage();
  overlay.on('pageerror', (e) => console.log('[overlay] page error:', e.message));
  await overlay.waitForSelector('.overlay-member', { timeout: 10000 });
  const names = await overlay.locator('.overlay-member-name').allTextContents();
  check(names.length === 2 && names[0] === bobWeb.name && names[1] === alice.name, `Bob first, then Alice (${names.join(', ')})`);
  check(await until(() => overlay.locator(`.overlay-member.speaking:has-text("${alice.name}")`).count().then((n) => n === 1), 10000), "Alice's ring lights while she talks");
  check(await overlay.locator('.overlay-hint').textContent() === 'Press Ctrl + Shift + O to use the overlay', 'how to use it, at first');
  const box = () => overlay.evaluate(() => ({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }));
  const content = () => overlay.evaluate(() => Math.ceil(document.querySelector('.overlay-content').getBoundingClientRect().height));
  check(await until(async () => {
    const b = await box();
    return b.x === 16 && b.y === 16 && b.width === 280 && b.height === await content();
  }, 5000), `top left, the size of its content (${JSON.stringify(await box())})`);
  if (shots) await overlay.screenshot({ path: join(shots, 'locked.png'), omitBackground: true });

  // A DM from Alice (another tab, so she stays in the call): a toast on the overlay ("New
  // message": Bob's app hasn't checked her keys yet, so it doesn't decrypt the preview).
  const aliceTab = await a.context().newPage();
  await openChat(aliceTab, bobWeb.id);
  await send(aliceTab, 'ready for the boss?');
  check(await until(() => overlay.locator(`.overlay-toast:has-text("${alice.name}")`).count().then((n) => n === 1), 10000), "Alice's DM shows as a toast");
  check(await overlay.locator('.overlay-member').count() === 2, 'Alice still in the call');
  check(await until(async () => (await box()).height === await content(), 5000), 'the window grows to fit it');
  if (shots) await overlay.screenshot({ path: join(shots, 'toast.png'), omitBackground: true });

  // The shortcut unlocks it: the whole screen, with its controls.
  press('Control_L', 'Shift_L', 'o');
  check(await until(() => overlay.locator('.overlay.unlocked').count().then((n) => n === 1), 5000), 'Ctrl+Shift+O unlocks it');
  check(await until(async () => {
    const b = await box();
    return b.x === 0 && b.y === 0 && b.width === SCREEN.width && b.height === SCREEN.height;
  }, 5000), 'over the whole screen');
  check(await overlay.locator('.overlay-voice-title').textContent() === 'lounge / Gamers', 'with the channel and guild');
  if (shots) await overlay.screenshot({ path: join(shots, 'unlocked.png') });
  await overlay.click('button[aria-label="Mute"]');
  check(await until(() => bob.locator('.user-panel button[aria-label="Unmute"]').count().then((n) => n === 1), 5000), "Mute mutes Bob's app");
  check(await until(() => overlay.locator('button[aria-label="Unmute"]').count().then((n) => n === 1), 5000), 'and the overlay shows it');
  await overlay.click('button[aria-label="Bottom right"]');
  check(await until(() => overlay.locator('button[aria-label="Bottom right"][aria-pressed="true"]').count().then((n) => n === 1), 5000), 'a corner picked');
  await overlay.keyboard.press('Escape');
  check(await until(() => overlay.locator('.overlay.locked').count().then((n) => n === 1), 5000), 'Escape locks it');
  check(await until(async () => {
    const b = await box();
    return b.x === SCREEN.width - 280 - 16 && b.y === SCREEN.height - b.height - 16;
  }, 5000), `now bottom right (${JSON.stringify(await box())})`);
  press('Control_L', 'Shift_L', 'o');
  check(await until(() => overlay.locator('.overlay.unlocked').count().then((n) => n === 1), 5000), 'the shortcut unlocks it again');
  press('Control_L', 'Shift_L', 'o');
  check(await until(() => overlay.locator('.overlay.locked').count().then((n) => n === 1), 5000), 'and locks it');

  // The game quits: the overlay goes.
  game.kill();
  check(await until(() => !overlayPage(), 25000), 'the game quitting takes it away');

  // Settings: on by default; off keeps it away while a game runs.
  // (Opened in the page, not loaded again: a reload leaves voice.)
  await bob.evaluate(() => {
    history.pushState({}, '', '/settings/desktop-app');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const toggle = bob.locator('label:has-text("Show the overlay in games") input');
  await toggle.waitFor({ timeout: 15000 });
  check(await toggle.isChecked(), 'the overlay is on by default');
  check(await bob.locator('select:near(:text("Position"))').first().inputValue() === 'bottom-right', 'the corner picked on it is kept');
  check(await bob.locator('button[aria-label="Overlay shortcut"]').textContent() === 'Ctrl + Shift + O', 'its shortcut is listed');
  if (shots) await bob.screenshot({ path: join(shots, 'settings.png') });
  await toggle.click();
  await until(async () => !(await toggle.isChecked()), 5000);
  startGame();
  await sleep(17000);
  check(await bob.locator('.voice-bar-status.connected').count() === 1, 'still in voice');
  check(!overlayPage(), 'off: none, even with a game running');
  await toggle.click();
  check(await until(() => Boolean(overlayPage()), 25000), 'on again: back');
} finally {
  game?.kill();
  electron?.kill();
  await browser.close();
  await sleep(500);
  xvfb.kill();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
