// Login with Voicaw in a real browser: a stand-in website (this script, on E2E_SITE_PORT, 3105)
// logs people in as a Discord site would. Alice makes an application, a client secret (shown
// once) and a redirect in the portal's OAuth2 tab; Bob, logged out, opens the site's login
// link, logs in to Voicaw, sees the consent card, authorises, and the site (its server trading
// the code and calling users/@me) greets him by name. prompt=none then goes straight back;
// Cancel comes back as access_denied; an unregistered redirect is shown, never followed;
// Settings → Authorised apps lists the site and Remove ends its token. Then a phone.
//   node e2e/serve.mjs &   then   node e2e/login.mjs [screenshot dir]
import http from 'node:http';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
};

const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3105);
const SITE = `http://localhost:${SITE_PORT}`;
const REDIRECT = `${SITE}/callback`;

// The stand-in website: /login sends you to Voicaw; /callback trades the code (server side, with
// the secret) and shows who you are. `client` is filled in once the portal has made it.
const client = { id: null, secret: null };
const tokens = []; // access tokens the site got
const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, SITE);
  const page = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Games Site</title><body>${body}</body>`);
  };
  if (url.pathname === '/login') {
    const query = new URLSearchParams({ client_id: client.id, response_type: 'code', scope: 'identify', redirect_uri: REDIRECT, state: 'st4te' });
    if (url.searchParams.get('prompt')) query.set('prompt', url.searchParams.get('prompt'));
    res.writeHead(302, { Location: `${BASE}/oauth2/authorize?${query}` });
    return res.end();
  }
  if (url.pathname === '/callback') {
    if (url.searchParams.get('error')) return page(`<p id="result">error: ${url.searchParams.get('error')}</p>`);
    if (url.searchParams.get('state') !== 'st4te') return page('<p id="result">bad state</p>');
    const tokenRes = await fetch(`${API}/api/v10/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.id, client_secret: client.secret, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) return page(`<p id="result">token failed: ${JSON.stringify(token)}</p>`);
    tokens.push(token.access_token);
    const me = await (await fetch(`${API}/api/v10/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
    return page(`<p id="result">Hello ${me.username} (${me.global_name ?? ''}) #${me.id}</p>`);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));

const meStatus = async (token) => (await fetch(`${API}/api/v10/users/@me`, { headers: { Authorization: `Bearer ${token}` } })).status;

const browser = await launchChrome();
try {
  // Alice sets up the application.
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const a = alice.page;
  await a.goto(`${BASE}/developers`);
  await a.click('button:has-text("New Application")');
  await a.fill('#dev-new-app-name', 'Games Site');
  await a.click('.vc-dialog button:has-text("Create")');
  await a.waitForSelector('#dev-bot-token');
  client.id = new URL(a.url()).pathname.split('/').pop();

  await a.click('[role="tab"]:has-text("OAuth2")');
  await a.waitForSelector('text=There\'s no client secret yet.');
  await a.click('button:has-text("Make Secret")');
  await a.waitForSelector('#dev-oauth-secret');
  client.secret = await a.inputValue('#dev-oauth-secret');
  if (client.secret.length < 20) throw new Error('odd client secret');
  // A bad redirect is refused, a good one added.
  await a.fill('input[placeholder="https://example.com/callback"]', 'http://games.example/callback');
  await a.click('button:has-text("Add Redirect")');
  await a.waitForSelector('.error-msg');
  await a.fill('input[placeholder="https://example.com/callback"]', REDIRECT);
  await a.click('button:has-text("Add Redirect")');
  await a.waitForSelector(`.dev-redirect-uri:has-text("${REDIRECT}")`);
  const link = await a.inputValue('#dev-oauth-link');
  if (!link.includes('scope=identify') || !link.includes(encodeURIComponent(REDIRECT))) throw new Error(`odd login link ${link}`);
  await shot(a, 'portal-oauth2');
  console.log('portal: client secret once, redirect added (http to another host refused), login link');

  // Bob, logged out, uses the site: Voicaw's login first, then the consent card.
  const bobAccount = await signUp(browser, 'bob');
  await bobAccount.page.context().close();
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const b = await bobContext.newPage();
  await b.goto(`${SITE}/login`);
  await b.fill('input[placeholder="Username"]', bobAccount.name);
  await b.fill('input[placeholder="Password"]', bobAccount.password);
  await b.click('button:has-text("Login")');
  await b.waitForSelector('text=Games Site wants to use your Voicaw account');
  await b.waitForSelector(`text=You're logged in as`);
  await b.waitForSelector('text=Know your username, display name and profile picture');
  await b.waitForSelector(`text=you'll go to localhost:${SITE_PORT}`);
  await shot(b, 'consent');
  await b.click('button:has-text("Authorise")');
  await b.waitForURL(new RegExp(`^${SITE}/callback`));
  const hello = await b.textContent('#result');
  if (!hello.startsWith(`Hello ${bobAccount.name}`)) throw new Error(`the site got: ${hello}`);
  console.log('logged in to the site:', hello);

  // prompt=none: straight back, no card.
  await b.goto(`${SITE}/login?prompt=none`);
  await b.waitForURL(new RegExp(`^${SITE}/callback`));
  if (!(await b.textContent('#result')).startsWith('Hello')) throw new Error('prompt=none did not log in');
  console.log('prompt=none went straight back');

  // Cancel: the site hears access_denied.
  await b.goto(`${SITE}/login`);
  await b.click('button:has-text("Cancel")');
  await b.waitForURL(new RegExp(`^${SITE}/callback`));
  if ((await b.textContent('#result')) !== 'error: access_denied') throw new Error('cancel did not come back as access_denied');
  console.log('Cancel came back as access_denied');

  // An unregistered redirect: shown, not followed.
  await b.goto(`${BASE}/oauth2/authorize?client_id=${client.id}&response_type=code&scope=identify&redirect_uri=${encodeURIComponent('https://evil.example/')}`);
  await b.waitForSelector('text=This login link doesn\'t work');
  if (!b.url().startsWith(BASE)) throw new Error('followed an unregistered redirect');
  await shot(b, 'bad-redirect');
  console.log('unregistered redirect refused on the page');

  // Settings → Authorised apps: listed; Remove ends the site's tokens.
  if (await meStatus(tokens[0]) !== 200) throw new Error('token should work before removing');
  await b.goto(`${BASE}/settings#authorised-apps`);
  await b.waitForSelector('#settings-authorised-apps .blocked-user-name:has-text("Games Site")');
  await shot(b, 'authorised-apps');
  await b.click('#settings-authorised-apps button:has-text("Remove")');
  await b.waitForSelector('text=You haven\'t logged in to any websites with Voicaw.');
  for (const token of tokens) if (await meStatus(token) !== 401) throw new Error('a token still works after Remove');
  console.log('Authorised apps: listed, Remove ended its tokens');

  // A phone: the consent card fits, and works.
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const c = carol.page;
  await c.goto(`${SITE}/login`);
  await c.waitForSelector('text=Games Site wants to use your Voicaw account');
  await shot(c, 'phone-consent');
  const overflow = await c.evaluate(() => document.querySelector('.dev-page').scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`the phone page is ${overflow}px too wide`);
  await c.click('button:has-text("Authorise")');
  await c.waitForURL(new RegExp(`^${SITE}/callback`));
  if (!(await c.textContent('#result')).startsWith(`Hello ${carol.name}`)) throw new Error('phone login failed');
  await c.goto(`${BASE}/settings#authorised-apps`);
  await c.waitForSelector('#settings-authorised-apps .blocked-user-name:has-text("Games Site")');
  await shot(c, 'phone-authorised-apps');
  console.log('phone: consent card fits, login works, listed in Settings');
  console.log('login: ok');
} catch (err) {
  console.error('login: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
}
