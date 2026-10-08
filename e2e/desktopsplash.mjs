// The desktop app's splash window (electron/splash.js, assets/splash.html). First its page in
// Chrome at the window's size, drawn in each state: checking (ring spins, line centred),
// downloading (ring fills, version and percent), "Start anyway" only once offered, installing,
// starting; light and reduced motion change nothing that matters. Then the real app (a
// development run, so no update) under Xvfb: the splash, the main window, then the splash
// closes. (Linux's square window gets a square card: `?square`.) Needs no API.
//   node e2e/desktopsplash.mjs [screenshot dir]
// E2E_SPLASH_DISPLAY (default :96) and E2E_SPLASH_CDP_PORT (default 9334) for the second part.
import { mkdirSync, mkdtempSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { launchChrome } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: join(dir, `${name}.png`) }) : null);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The page, state by state ---
const browser = await launchChrome();
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 340 } });
  await page.goto(pathToFileURL(join(root, 'electron/assets/splash.html')).href);
  const squareCorners = async () => {
    const square = await browser.newPage({ viewport: { width: 300, height: 340 } });
    await square.goto(`${pathToFileURL(join(root, 'electron/assets/splash.html')).href}?square`);
    const radius = await square.evaluate(() => getComputedStyle(document.querySelector('.card')).borderRadius);
    await square.close();
    return radius;
  };
  check(await squareCorners() === '0px', 'Linux (?square): square card');
  const read = () => page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const text = document.getElementById('text');
    const arc = document.getElementById('arc');
    return {
      text: text.textContent,
      detail: document.getElementById('detail').textContent,
      spinning: document.getElementById('ring').classList.contains('spin'),
      filled: 1 - parseFloat(arc.style.strokeDashoffset) / parseFloat(arc.style.strokeDasharray),
      startShown: getComputedStyle(document.getElementById('start-anyway')).visibility === 'visible',
      // The line's middle against the window's (the dots after it are balanced by space before).
      textOffset: box(text).left + box(text).width / 2 - window.innerWidth / 2,
      birdLoaded: document.querySelector('.bird').naturalWidth > 0,
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });

  let s = await read();
  check(s.text === 'Starting' && s.spinning, 'opens on "Starting", spinning');
  check(s.birdLoaded, 'the bird is drawn');
  check(!s.scrolls, 'fits the window');

  await page.evaluate(() => window.showView({ ring: 'spin', text: 'Checking for updates' }));
  await sleep(700);
  s = await read();
  check(s.text === 'Checking for updates' && s.spinning && !s.detail, 'checking: spins, no detail');
  check(Math.abs(s.textOffset) < 2, `checking: line centred (${s.textOffset.toFixed(1)} px off)`);
  await shot(page, '1-checking');

  await page.evaluate(() => window.showView({ ring: 'progress', text: 'Downloading update', detail: 'Version 0.2.0' }));
  await page.evaluate(() => window.showProgress(0.42));
  await sleep(400);
  s = await read();
  check(!s.spinning && Math.abs(s.filled - 0.42) < 0.01, `downloading: ring 42% full, not spinning (${s.filled.toFixed(2)})`);
  check(s.detail === 'Version 0.2.0 · 42%', `downloading: version and percent ("${s.detail}")`);
  check(!s.startShown, 'no "Start anyway" yet');
  await shot(page, '2-downloading');

  await page.evaluate(() => window.offerStart());
  await sleep(400);
  s = await read();
  check(s.startShown, '"Start anyway" once offered');
  await shot(page, '3-start-anyway');

  await page.evaluate(() => window.showView({ ring: 'spin', text: 'Installing update', detail: 'Version 0.2.0' }));
  s = await read();
  check(s.spinning && !s.startShown && s.detail === 'Version 0.2.0', 'installing: spins, "Start anyway" gone, no percent');
  await shot(page, '4-installing');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.showView({ ring: 'spin', text: 'Starting' }));
  const still = await page.evaluate(() => getComputedStyle(document.querySelector('.bird')).animationName);
  check(still === 'none', 'reduced motion: the bird keeps still');
  await shot(page, '5-starting-reduced-motion');
} finally {
  await browser.close();
}

// --- The real app: splash first, then the main window ---
const display = process.env.E2E_SPLASH_DISPLAY || ':96';
const cdpPort = process.env.E2E_SPLASH_CDP_PORT || '9334';
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await sleep(500);
const electron = spawn(join(root, 'node_modules/electron/dist/electron'),
  [join(root, 'electron/main.js'), '--no-sandbox', `--remote-debugging-port=${cdpPort}`],
  { env: { ...process.env, DISPLAY: display, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'voicaw-splash-')) }, stdio: 'ignore' });
try {
  const seen = []; // the targets' URLs, in the order they first appeared
  let splashGone = false;
  for (let i = 0; i < 300; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const urls = targets.filter((t) => t.type === 'page').map((t) => t.url);
      for (const url of urls) if (!seen.includes(url)) seen.push(url);
      if (seen.some((u) => u.includes('/splash.html')) && !urls.some((u) => u.includes('/splash.html'))) {
        splashGone = urls.some((u) => u.startsWith('voicaw://app/'));
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(50);
  }
  // (A development run has no update to look for, so both appear at once: the list's order
  // isn't theirs.)
  check(seen.some((u) => u.includes('/splash.html')), 'the splash opens');
  check(seen.some((u) => u.startsWith('voicaw://app/')), 'the main window opens');
  check(splashGone, 'then the splash closes, the main window stays');
} finally {
  electron.kill();
  await sleep(300);
  xvfb.kill();
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
