// The real desktop app keeping its login in its own file (electron/loginStore.js), under Xvfb:
// a Windows PC's Chromium storage kept going back to an expired, month-old token after every
// login, and a reload lost the page's in-memory guard. Logs in, then makes localStorage hold an
// expired token of the same account and reloads, then restarts the app: still logged in, no
// 403s. Logging out writes "logged out" there, so the stale token doesn't come back either.
// Needs the client built for the desktop app, pointed at the throwaway API (README).
//   node e2e/serve.mjs &   then   node e2e/desktoplogin.mjs
// E2E_LOGIN_DISPLAY (default :89) and E2E_LOGIN_CDP_PORT (default 9361).
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { chromium } from 'playwright-core';
import { launchChrome, signUp } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/index.js'));
const jwt = require('jsonwebtoken');
const display = process.env.E2E_LOGIN_DISPLAY || ':89';
const cdpPort = process.env.E2E_LOGIN_CDP_PORT || '9361';

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = mkdtempSync(join(tmpdir(), 'voicaw-login-'));
const loginFile = () => {
  const dir = readdirSync(config).map((d) => join(config, d)).find((d) => existsSync(join(d, 'login.json')));
  return dir ? JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8')) : null;
};

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
await sleep(800);

// Starts the app on the same data folder each time; resolves to its main page.
async function start() {
  const electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [join(root, 'electron/main.js'), '--no-sandbox', '--enable-automation', `--remote-debugging-port=${cdpPort}`],
    { env: { ...process.env, WAYLAND_DISPLAY: '', DISPLAY: display, XDG_CONFIG_HOME: config }, stdio: 'ignore' });
  let app;
  for (let i = 0; i < 200 && !app; i++) {
    await sleep(100);
    try { app = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch { /* not yet */ }
  }
  let page;
  for (let i = 0; i < 200 && !page; i++) {
    page = app.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('voicaw://app/'));
    if (!page) await sleep(100);
  }
  const refused = [];
  page.on('response', (r) => { if (r.url().includes('/api/') && !r.url().includes('/admin/') && r.status() === 403) refused.push(r.url()); });
  return { electron, app, page, refused };
}
async function stop({ electron, app }) {
  await app.close().catch(() => {});
  electron.kill();
  await new Promise((resolve) => (electron.exitCode !== null ? resolve() : electron.on('exit', resolve)));
}
const inApp = (page) => page.waitForSelector('#dm-main', { timeout: 20000 }).then(() => true, () => false);

let run;
try {
  const browser = await launchChrome();
  const ann = await signUp(browser, 'ann');
  await browser.close();

  run = await start();
  await run.page.waitForSelector('input[placeholder="Username"]', { timeout: 20000 });
  check(loginFile() === null, 'no login file before logging in');
  await run.page.fill('input[placeholder="Username"]', ann.name);
  await run.page.fill('input[placeholder="Password"]', ann.password);
  await run.page.click('button:has-text("Login")');
  check(await inApp(run.page), 'logged in in the desktop app');
  const fresh = await run.page.evaluate(() => localStorage.getItem('token'));
  check(loginFile()?.token === fresh, 'the login is in the app\'s own file');

  const { id, username } = JSON.parse(Buffer.from(fresh.split('.')[1], 'base64url'));
  const iat = Math.floor(Date.now() / 1000) - 35 * 86400;
  const stale = jwt.sign({ id, username, sid: 'gone', iat, exp: iat + 30 * 86400 }, 'e2e-only-secret');

  await run.page.evaluate((t) => localStorage.setItem('token', t), stale);
  await run.page.reload();
  check(await inApp(run.page), 'localStorage back to an expired token, then a reload: still in the app');
  await run.page.click('text=Notes').catch(() => {});
  await sleep(1500);
  await run.page.click('text=Friends').catch(() => {});
  await sleep(1500);
  check(run.refused.length === 0, `no 403s (${run.refused.slice(0, 3).join(', ')})`);

  await run.page.evaluate((t) => localStorage.setItem('token', t), stale);
  await stop(run);
  run = await start();
  check(await inApp(run.page), 'restarted with the expired token in localStorage: still logged in');
  await sleep(1500);
  check(run.refused.length === 0, `no 403s after the restart (${run.refused.slice(0, 3).join(', ')})`);

  await run.page.click('.user-panel-me');
  await run.page.click('.user-menu-item:has-text("Log out")');
  await run.page.waitForSelector('input[placeholder="Username"]', { timeout: 20000 });
  check(loginFile()?.token === null, 'logging out writes "logged out" to the file');
  await run.page.evaluate((t) => localStorage.setItem('token', t), stale);
  await run.page.reload();
  await sleep(2000);
  check(await run.page.isVisible('input[placeholder="Username"]') && run.refused.length === 0,
    'an old token coming back to localStorage after the logout is ignored (login page, nothing sent)');
} finally {
  if (run) await stop(run);
  xvfb.kill();
}
console.log(failures ? `${failures} FAILED` : 'OK');
process.exit(failures ? 1 : 0);
