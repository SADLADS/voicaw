// The favicon dot: a DM puts a red dot on the tab's icon, opening it takes it away; a guild
// message without a mention doesn't (as in Discord), a mention does.
//   node e2e/serve.mjs &   then   node e2e/favicon.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const iconHref = (page) => page.$eval('link[rel="icon"]', (l) => l.getAttribute('href'));
const waitForDot = (page, on) => page.waitForFunction(
  (want) => document.querySelector('link[rel="icon"]').getAttribute('href').startsWith('data:image/png') === want,
  on, { timeout: 10000 },
);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const b = bob.page;

  // Bob waits in a guild of his own, so no chat with Alice is open.
  const own = await api(b, 'POST', '/guilds', { name: 'Elsewhere' });
  const ownId = own.id ?? own.guild?.id;
  await b.goto(`${BASE}/guild/${ownId}`);
  await b.waitForSelector('#dm-input');
  check((await iconHref(b)) === '/favicon.ico', 'nothing unread: the plain icon');

  await openChat(alice.page, bob.id);
  await send(alice.page, 'psst');
  await waitForDot(b, true);
  check(true, 'a DM puts the dot on');
  if (dir) {
    const href = await iconHref(b);
    const shot = await browser.newPage();
    await shot.setContent(`<body style="margin:0;background:#ddd"><img src="${href}" width="64"><img src="${href}" width="16" style="margin:8px"></body>`);
    await shot.screenshot({ path: `${dir}/favicon.png`, clip: { x: 0, y: 0, width: 100, height: 64 } });
    await shot.close();
  }

  await openChat(b, alice.id);
  await waitForDot(b, false);
  check((await iconHref(b)) === '/favicon.ico', 'reading it puts the plain icon back');

  // A guild both are in; Bob back in his own one.
  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Shared' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(alice.page, 'POST', `/guilds/${guildId}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  await b.goto(`${BASE}/guild/${ownId}`);
  await b.waitForSelector('#dm-input');
  await alice.page.goto(`${BASE}/guild/${guildId}`);
  await alice.page.waitForSelector('#dm-input');

  await send(alice.page, 'just chatting');
  const railDot = b.locator('.nav-item', { has: b.locator('[aria-label="Shared"]') }).locator('.dot.visible');
  await railDot.waitFor({ timeout: 10000 });
  await b.waitForTimeout(500);
  check((await iconHref(b)) === '/favicon.ico', 'a guild message without a mention: rail dot, no favicon dot');

  const a = alice.page;
  await a.click('#dm-input');
  await a.keyboard.type('hey @');
  await a.waitForSelector('.mention-suggestions');
  await a.keyboard.type(bob.name.slice(0, 3));
  await a.keyboard.press('Enter');
  await a.keyboard.type('look');
  await a.keyboard.press('Enter');
  await waitForDot(b, true);
  check(true, 'a mention puts the dot on');

  await b.goto(`${BASE}/guild/${guildId}`);
  await b.waitForSelector('text=look');
  await waitForDot(b, false);
  check(true, 'reading the mention takes it off');
  console.log('favicon: ok');
} catch (err) {
  console.error('favicon: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
