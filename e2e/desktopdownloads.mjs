// The download popup in the real desktop app under Xvfb (electron/downloads.js): on the login
// page, a file the page has whole (`<a download>`, Electron's own download) and a big one
// written piece by piece (fileSave.js) each show "Download complete" with their names and
// folder, newest first; Delete takes the file away (to the bin in the app's home, or for
// good); Open file on one deleted by hand says it isn't there. Xvfb has no one to answer the
// Save dialog, so the main process is told where to save over Node's inspector instead.
// Here (2026-10-29) Electron's own downloads report "completed" without the file ever reaching
// the disk (http ones too; likely the chats' sandbox), so the files are checked only for the
// piece-by-piece ones. (Show in folder and opening a real file would start the host's file
// manager or an app, so they're left to the unit tests and e2e/downloads.mjs.)
//   node e2e/serve.mjs &   (the client built for the desktop app against it first: README,
//   "The real desktop app")   then   node e2e/desktopdownloads.mjs [screenshot dir]
// E2E_DOWNLOADS_DISPLAY (:91), E2E_DOWNLOADS_CDP_PORT (9351), E2E_DOWNLOADS_INSPECT_PORT (9352).
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(import.meta.url)(join(root, 'node_modules/ws'));
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

if (!existsSync(join(root, 'build', 'index.html'))) {
  console.log('Build the client for the desktop app first (see the top of this file).');
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'voicaw-downloads-'));
const home = join(scratch, 'home');
const saved = join(scratch, 'saved');
mkdirSync(saved, { recursive: true });
mkdirSync(join(scratch, 'run'), { recursive: true, mode: 0o700 });
const display = process.env.E2E_DOWNLOADS_DISPLAY || ':91';
const cdpPort = process.env.E2E_DOWNLOADS_CDP_PORT || '9351';
const inspectPort = process.env.E2E_DOWNLOADS_INSPECT_PORT || '9352';

// Runs `expression` in the app's main process (Node's inspector, with its require).
async function inMain(expression) {
  const [target] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const reply = new Promise((resolve) => socket.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.id === 1) resolve(message);
  }));
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }));
  const { result } = await reply;
  socket.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'failed');
  return result.result.value;
}

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
let electron = null;
let app = null;
try {
  await sleep(500);
  electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [`--inspect=${inspectPort}`, join(root, 'electron/main.js'), '--no-sandbox', `--remote-debugging-port=${cdpPort}`],
    { env: { ...process.env, DISPLAY: display, HOME: home, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_RUNTIME_DIR: join(scratch, 'run') }, stdio: 'ignore' });
  const pages = () => app.contexts().flatMap((c) => c.pages());
  await until(async () => {
    app ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    return pages().some((p) => p.url().startsWith('voicaw://app/'));
  }, 40000);
  const page = pages().find((p) => p.url().startsWith('voicaw://app/'));
  page.on('pageerror', (e) => console.log('[app] page error:', e.message));
  await page.waitForSelector('input[placeholder="Username"]', { timeout: 30000 });

  // The person's answer to the Save dialogs: the file's own name, in `saved`.
  await inMain(`(() => {
    const path = require('path');
    const { session, dialog } = require('electron');
    const dir = ${JSON.stringify(saved)};
    session.defaultSession.on('will-download', (event, item) => item.setSavePath(path.join(dir, item.getFilename())));
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: path.join(dir, path.basename(args.at(-1).defaultPath)) });
    return true;
  })()`);

  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(['hello'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'small.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  check(await until(() => page.isVisible('.downloads-popup-name:text-is("small.txt")')), '<a download>: "Download complete" with its name');
  check(await page.isVisible('text=Saved in saved'), 'says which folder');

  const saveInPieces = (name, pieces) => page.evaluate(async ([n, p]) => {
    const { saveFile } = window.voicawDesktop;
    const id = await saveFile.start(n);
    for (const bytes of p) await saveFile.append(id, new Uint8Array(bytes));
    await saveFile.finish(id);
  }, [name, pieces]);
  await saveInPieces('big.bin', [[1, 2, 3], [4]]);
  check(await until(() => page.isVisible('.downloads-popup-name:text-is("big.bin")')), 'a file written piece by piece: listed too');
  const names = await page.$$eval('.downloads-popup-name', (els) => els.map((el) => el.textContent));
  check(names.join() === 'big.bin,small.txt', `newest first (${names})`);
  check([...readFileSync(join(saved, 'big.bin'))].join() === '1,2,3,4', 'its bytes, whole, where the dialog said');
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: join(shots, 'app.png') });

  await page.hover('.downloads-popup');
  await page.click('.downloads-popup-item:has-text("big.bin") >> text=Delete');
  check(await until(() => !existsSync(join(saved, 'big.bin'))), 'Delete takes the file away');
  check(await until(async () => !(await page.isVisible('.downloads-popup-name:text-is("big.bin")'))), '…and its entry');

  await saveInPieces('gone.bin', [[5]]);
  await page.waitForSelector('.downloads-popup-name:text-is("gone.bin")');
  rmSync(join(saved, 'gone.bin'));
  await page.click('.downloads-popup-item:has-text("gone.bin") >> text=Open file');
  check(await until(() => page.isVisible("text=The file isn't there any more")), 'Open file on a file deleted by hand says it has gone');
} finally {
  await app?.close().catch(() => {});
  electron?.kill();
  await sleep(500);
  xvfb.kill();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
