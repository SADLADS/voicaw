// The login screen's Server (client/src/utils/server.js): starts a second throwaway API on
// E2E_API2_PORT (default API + 20, its object store on the next port), which takes the web app's
// origin through ALLOWED_ORIGINS as another host would. A bad address and a site that isn't
// Voicaw are refused; two people sign up on the second server through the picker (requests go
// straight to it, not the web app's own API), message each other live over its websocket (on
// /api/socket), aren't on the first server, and stay on the second after a reload; "Use …"
// goes back. Phone screenshots.
//   node e2e/serve.mjs &   then   node e2e/servers.mjs [dir]
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
const apiPort = Number(process.env.E2E_API_PORT || 3099);
const api2Port = Number(process.env.E2E_API2_PORT || apiPort + 20);
const SECOND = `http://localhost:${api2Port}`;
const root = fileURLToPath(new URL('..', import.meta.url));

const second = spawn(process.execPath, ['e2e/start-api.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    E2E_API_PORT: String(api2Port),
    E2E_S3_PORT: String(api2Port + 1),
    ALLOWED_ORIGINS: BASE,
    LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
  },
});
second.stdout.on('data', () => {});

async function waitForSecond() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${SECOND}/api/config`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('second API never started');
}

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// Picks the server on the login screen and waits for the page to reload onto it.
async function chooseServer(page, address) {
  await page.click('.login-server button:has-text("Change")');
  await page.fill('input[name="server"]', address);
  await Promise.all([page.waitForEvent('load'), page.click('button:has-text("Connect")')]);
  await page.waitForSelector('.login-server');
}

async function signUpHere(page, name) {
  const username = `${name}${String(Date.now()).slice(-5)}`;
  await page.fill('input[placeholder="New Username"]', username);
  await page.fill('input[placeholder="New Password"]', `correct horse battery ${name}`);
  await page.check('label:has-text("I agree to the") input');
  await page.click('button:has-text("Register")');
  await page.waitForSelector('[aria-label="Recovery code"]', { timeout: 20000 });
  await page.check('text=I\'ve saved my recovery code');
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  const id = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/api/profile`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).id;
  }, SECOND);
  return { username, id };
}

const browser = await launchChrome();
try {
  await waitForSecond();
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[alice] page error:', e.message));
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.goto(`${BASE}/`);
  const builtInHost = new URL(BASE).host;
  check((await page.textContent('.login-server')).includes(`Server: ${builtInHost}`), 'login screen names the built-in server');

  await page.click('.login-server button:has-text("Change")');
  await shot(page, 'servers-form');
  await page.fill('input[name="server"]', 'ftp://nope');
  await page.click('button:has-text("Connect")');
  await page.waitForSelector('.login-server-form .login-error');
  check((await page.textContent('.login-server-form .login-error')).includes("isn't a server address"), 'a non-web address is refused');
  // The object store answers, but it isn't a Voicaw server.
  await page.fill('input[name="server"]', `http://localhost:${api2Port + 1}`);
  await page.click('button:has-text("Connect")');
  await page.waitForFunction(() => document.querySelector('.login-server-form .login-error')?.textContent.includes("Couldn't find"));
  check(true, 'a site that is not a Voicaw server is refused');
  await page.click('.login-server-form button:has-text("Cancel")');

  await chooseServer(page, SECOND);
  check((await page.textContent('.login-server')).includes(`Server: localhost:${api2Port}`), 'after the reload the login screen names the second server');
  await shot(page, 'servers-login');

  requests.length = 0;
  const alice = await signUpHere(page, 'alice');
  const apiCalls = requests.filter((url) => url.includes('/api/'));
  check(apiCalls.length > 0 && apiCalls.every((url) => url.startsWith(`${SECOND}/api/`)), `every API request went to the second server (${apiCalls.length})`);
  // Someone on the first server doesn't see them in its directory.
  const carol = await signUp(browser, 'carol');
  const directory = await carol.page.evaluate(async () => {
    const res = await fetch('/api/dms-list', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).map((user) => user.username);
  });
  check(Array.isArray(directory) && !directory.includes(alice.username), 'the first server knows nothing of it');
  await carol.page.context().close();

  const bobContext = await browser.newContext(devices['Pixel 7']);
  const bobPage = await bobContext.newPage();
  bobPage.on('pageerror', (e) => console.log('[bob] page error:', e.message));
  await bobPage.goto(`${BASE}/`);
  await chooseServer(bobPage, `${SECOND}/`);
  await shot(bobPage, 'servers-phone-login');
  const bob = await signUpHere(bobPage, 'bob');

  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto(`${BASE}/dm/${bob.id}`);
  await page.waitForSelector('#dm-input');
  check(sockets.some((url) => url === `ws://localhost:${api2Port}/api/socket`), 'its websocket is /api/socket on the second server');
  await bobPage.goto(`${BASE}/dm/${alice.id}`);
  await bobPage.waitForSelector('#dm-input');
  await page.click('#dm-input');
  await page.keyboard.type('hello from another server');
  await page.keyboard.press('Enter');
  await bobPage.waitForSelector('text=hello from another server', { timeout: 15000 });
  check(true, 'a DM arrives live on the other device');
  await shot(bobPage, 'servers-phone-dm');

  await page.reload();
  await page.waitForSelector('text=hello from another server', { timeout: 15000 });
  check(true, 'still on the second server after a reload');

  // Logging out keeps the server; "Use …" goes back to the built-in one.
  await page.evaluate(async () => {
    const { logOut } = await import('/src/services/logout.js');
    await logOut();
  });
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.login-server');
  check((await page.textContent('.login-server')).includes(`localhost:${api2Port}`), 'logged out, the login screen stays on the second server');
  await page.click('.login-server button:has-text("Change")');
  await shot(page, 'servers-form-back');
  await Promise.all([page.waitForEvent('load'), page.click(`button:has-text("Use ${builtInHost}")`)]);
  await page.waitForSelector('.login-server');
  check((await page.textContent('.login-server')).includes(`Server: ${builtInHost}`), '"Use …" goes back to the built-in server');
  check(await page.evaluate(() => localStorage.getItem('server')) === null, 'and forgets the choice');
  console.log('servers: ok');
} catch (err) {
  console.error('servers: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  second.kill();
}
