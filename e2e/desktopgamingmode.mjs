// The desktop app in the Steam Deck's Gaming Mode (electron/gamingMode.js), faked with
// XDG_CURRENT_DESKTOP=gamescope under Xvfb: no splash, the main window opens on X11, and
// closing it quits the app (no tray to hide in). Then the same without it (an ordinary Linux
// desktop): the splash opens and closing hides the window, the app still running. A
// development run, so there's no update; needs the client built for the desktop app (any API
// address: nothing logs in).
//   node e2e/desktopgamingmode.mjs
// E2E_GAMING_DISPLAY (default :92) and E2E_GAMING_CDP_PORT (default 9342).
import { mkdtempSync } from 'fs';
import { spawn, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const display = process.env.E2E_GAMING_DISPLAY || ':92';
const cdpPort = process.env.E2E_GAMING_CDP_PORT || '9342';

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Closes the app's main window the way a window manager's close button does: WM_DELETE_WINDOW
// (the page's own window.close() skips the 'close' event the app can stop). Xvfb has no
// window manager, so it's sent straight to the window, found by xwininfo (the one at least
// 480 wide: the splash is 300).
const SEND_DELETE = `
import ctypes, sys
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x.XFlush.argtypes = [ctypes.c_void_p]
class Ev(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('data', ctypes.c_long * 5), ('pad', ctypes.c_long * 12)]
d = x.XOpenDisplay(sys.argv[1].encode())
w = int(sys.argv[2], 16)
ev = Ev(type=33, window=w, message_type=x.XInternAtom(d, b'WM_PROTOCOLS', 0), format=32)
ev.data[0] = x.XInternAtom(d, b'WM_DELETE_WINDOW', 0)
x.XSendEvent(d, w, 0, 0, ctypes.byref(ev))
x.XFlush(d)
`;
function closeLikeAWindowManager() {
  const tree = execFileSync('xwininfo', ['-display', display, '-root', '-tree'], { encoding: 'utf8' });
  const main = tree.split('\n').map((line) => line.match(/^\s*(0x[0-9a-f]+) "Voicaw.*?: \(.*?\)\s+(\d+)x(\d+)/))
    .find((m) => m && Number(m[2]) >= 480);
  if (!main) throw new Error('No main window on the X display');
  execFileSync('python3', ['-I', '-c', SEND_DELETE, display, main[1]]);
}

// Starts the app with `env`, waits for the main window, and reports what it saw.
async function run(env) {
  const electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [join(root, 'electron/main.js'), '--no-sandbox', '--enable-automation', `--remote-debugging-port=${cdpPort}`],
    { env: { ...process.env, WAYLAND_DISPLAY: '', DISPLAY: display, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'voicaw-gaming-')), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  electron.stdout.on('data', (d) => { output += d; });
  electron.stderr.on('data', (d) => { output += d; });
  let exited = false;
  electron.on('exit', () => { exited = true; });
  const seen = [];
  try {
    for (let i = 0; i < 300 && !seen.some((u) => u.startsWith('voicaw://app/')); i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        for (const t of targets) if (t.type === 'page' && !seen.includes(t.url)) seen.push(t.url);
      } catch {
        // not listening yet
      }
      await sleep(50);
    }
    const app = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const cdp = await app.newBrowserCDPSession();
    const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
    const page = app.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('voicaw://app/'));
    if (!page) {
      console.log('No main window; pages seen:', seen, '\nThe app said:\n', output.slice(-3000));
      return { seen, args, stillRunning: !exited };
    }
    // Once the splash (if any) has closed and the page is up.
    await page.waitForLoadState('load');
    for (let i = 0; i < 200 && app.contexts().flatMap((c) => c.pages()).some((p) => p.url().includes('/splash.html')); i++) await sleep(50);
    closeLikeAWindowManager();
    await sleep(2000);
    const stillRunning = !exited;
    if (process.env.E2E_GAMING_VERBOSE) console.log(output.split('\n').filter((l) => !l.includes('dbus')).join('\n'));
    await app.close().catch(() => {});
    return { seen, args, stillRunning };
  } finally {
    if (!exited) electron.kill();
    await sleep(500);
  }
}

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
await sleep(500);
try {
  const gaming = await run({ XDG_CURRENT_DESKTOP: 'gamescope' });
  check(!gaming.seen.some((u) => u.includes('/splash.html')), 'Gaming Mode: no splash');
  check(gaming.seen.some((u) => u.startsWith('voicaw://app/')), 'Gaming Mode: the main window opens');
  check(gaming.args.includes('--ozone-platform=x11'), 'Gaming Mode: on X11');
  check(!gaming.stillRunning, 'Gaming Mode: closing the window quits the app');

  const desktop = await run({ XDG_CURRENT_DESKTOP: 'KDE' });
  check(desktop.seen.some((u) => u.includes('/splash.html')), 'Desktop Mode: the splash opens');
  check(desktop.stillRunning, 'Desktop Mode: closing the window leaves it running in the tray');
} finally {
  xvfb.kill();
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
