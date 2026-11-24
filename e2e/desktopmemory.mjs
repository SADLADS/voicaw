// Not a check: the real desktop app's memory and start-up times under Xvfb, to measure changes
// against (Memory and start-up in docs/desktop-and-site.md). First an empty Electron window (the
// floor nothing of ours can go below), then the app: cold start to the login screen, logged in
// and idle, a DM with 40 messages open, and starts already logged in. Memory is PSS (shared pages
// split between the processes using them) of the whole process tree, by Chromium process type;
// each helper process is also reported when it first appears. Needs the client built for the
// desktop app, pointed at the throwaway API (README: the real desktop app).
//   node e2e/serve.mjs &   then   node e2e/desktopmemory.mjs
// E2E_MEMORY_DISPLAY (default :74) and E2E_MEMORY_CDP_PORT (default 9374).
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { launchChrome, signUp, makeFriends, openChat, send } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const display = process.env.E2E_MEMORY_DISPLAY || ':74';
const cdpPort = process.env.E2E_MEMORY_CDP_PORT || '9374';
const electronBin = join(root, 'node_modules/electron/dist/electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every process under `rootPid`, with its Chromium type and PSS in MB.
function processes(rootPid) {
  const children = new Map();
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1];
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    } catch { /* gone */ }
  }
  const tree = [];
  const walk = (pid) => { tree.push(pid); for (const child of children.get(pid) ?? []) walk(child); };
  walk(String(rootPid));
  const found = [];
  for (const pid of tree) {
    try {
      // Chromium rewrites its command line, joining the arguments with spaces.
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
      const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      const sub = flag('utility-sub-type');
      const type = `${flag('type') ?? 'main (Node)'}${sub ? `: ${sub.split('.').pop()}` : ''}`;
      const mb = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1]) / 1024;
      found.push({ pid, type, mb });
    } catch { /* gone */ }
  }
  return found;
}

function report(label, list, heapMb) {
  const byType = {};
  for (const { type, mb } of list) {
    byType[type] ??= { count: 0, mb: 0 };
    byType[type].count++;
    byType[type].mb += mb;
  }
  const total = list.reduce((sum, p) => sum + p.mb, 0);
  console.log(`\n== ${label}: ${total.toFixed(0)} MB${heapMb != null ? ` (page JS heap ${heapMb.toFixed(0)} MB)` : ''}`);
  for (const [type, { count, mb }] of Object.entries(byType).sort((a, b) => b[1].mb - a[1].mb)) {
    console.log(`  ${mb.toFixed(0).padStart(5)} MB  ${type}${count > 1 ? ` ×${count}` : ''}`);
  }
}

// Logs each helper process the moment it appears (with what the page was doing), until stopped.
function watchSpawns(rootPid, t0, page) {
  const seen = new Set();
  const timer = setInterval(() => {
    for (const { pid, type } of processes(rootPid)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (seen.size > 1) console.log(`  + ${type} at ${Date.now() - t0} ms${page() ? ` (${page().url()})` : ''}`);
    }
  }, 50);
  return () => clearInterval(timer);
}

async function jsHeap(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  return metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1024 / 1024;
}

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await sleep(800);
const env = (config) => ({ ...process.env, WAYLAND_DISPLAY: '', DISPLAY: display, XDG_CONFIG_HOME: config });

async function floor() {
  const dir = mkdtempSync(join(tmpdir(), 'voicaw-memory-floor-'));
  writeFileSync(join(dir, 'main.js'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => new BrowserWindow({ width: 1280, height: 800 }).loadURL('data:text/html,<h1>empty</h1>'));`);
  const electron = spawn(electronBin, [join(dir, 'main.js'), '--no-sandbox'], { env: env(dir), stdio: 'ignore' });
  await sleep(8000);
  report('empty Electron window (the floor)', processes(electron.pid));
  electron.kill();
  await new Promise((resolve) => (electron.exitCode !== null ? resolve() : electron.on('exit', resolve)));
}

const config = mkdtempSync(join(tmpdir(), 'voicaw-memory-'));
async function start() {
  const t0 = Date.now();
  const electron = spawn(electronBin,
    [join(root, 'electron/main.js'), '--no-sandbox', '--enable-automation', `--remote-debugging-port=${cdpPort}`],
    { env: env(config), stdio: 'ignore' });
  let page = null;
  const stopWatching = watchSpawns(electron.pid, t0, () => page);
  let app;
  for (let i = 0; i < 300 && !app; i++) {
    await sleep(50);
    try { app = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch { /* not yet */ }
  }
  for (let i = 0; i < 600 && !page; i++) {
    page = app.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('voicaw://app/')) ?? null;
    if (!page) await sleep(25);
  }
  return { electron, app, page, t0, tPage: Date.now() - t0, stopWatching };
}
async function stop(run) {
  run.stopWatching();
  await run.app.close().catch(() => {});
  run.electron.kill();
  await new Promise((resolve) => (run.electron.exitCode !== null ? resolve() : run.electron.on('exit', resolve)));
}

let run;
try {
  await floor();

  const browser = await launchChrome();
  const ann = await signUp(browser, 'ann');
  const bob = await signUp(browser, 'bob');
  await makeFriends(ann, bob);
  await openChat(bob.page, ann.id);
  for (let i = 0; i < 40; i++) await send(bob.page, `message ${i} with some **bold** text and https://example.com/${i}`);
  await sleep(1500);
  await browser.close();

  console.log('\ncold start (new profile, logged out):');
  run = await start();
  await run.page.waitForSelector('input[placeholder="Username"]', { timeout: 30000 });
  console.log(`  window's page after ${run.tPage} ms, login screen after ${Date.now() - run.t0} ms`);
  await sleep(5000);
  report('logged out, login screen', processes(run.electron.pid), await jsHeap(run.page));

  await run.page.fill('input[placeholder="Username"]', ann.name);
  await run.page.fill('input[placeholder="Password"]', ann.password);
  const tLogin = Date.now();
  await run.page.click('button:has-text("Login")');
  await run.page.waitForSelector('#dm-main', { timeout: 30000 });
  console.log(`\nlogged in after ${Date.now() - tLogin} ms`);
  await sleep(10000);
  report('logged in, idle', processes(run.electron.pid), await jsHeap(run.page));

  // In-app navigation (no reload), as clicking the DM would.
  await run.page.evaluate((id) => {
    history.pushState({}, '', `/dm/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, bob.id);
  await run.page.waitForSelector('#dm-input', { timeout: 20000 });
  await sleep(8000);
  report('a DM with 40 messages open', processes(run.electron.pid), await jsHeap(run.page));
  await stop(run);
  run = null;

  for (const n of [1, 2]) {
    console.log(`\nstart ${n} already logged in:`);
    run = await start();
    await run.page.waitForSelector('#dm-main, #dm-input', { timeout: 30000 });
    console.log(`  window's page after ${run.tPage} ms, app shown after ${Date.now() - run.t0} ms`);
    if (n === 2) {
      await sleep(10000);
      report('started logged in, idle', processes(run.electron.pid), await jsHeap(run.page));
    }
    await stop(run);
    run = null;
  }
} finally {
  if (run) await stop(run).catch(() => {});
  xvfb.kill();
}
