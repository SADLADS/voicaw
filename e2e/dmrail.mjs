// The rail's DM button: its icon while nothing's unread, the picture of whoever sent the newest
// unread DM otherwise (live, and after a reload), the one before once that's read, the icon again
// when everything is; on a phone too.
//   node e2e/serve.mjs &   then   node e2e/dmrail.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, devices, BASE } from './helpers.mjs';

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

// Whose picture the DM button shows (its label names them), or null for the plain icon.
const button = (page) => page.locator('.sidebar a[href="/dm"]');
const waitForButton = (page, name) => page.waitForFunction((want) => {
  const a = document.querySelector('.sidebar a[href="/dm"]');
  const label = a?.getAttribute('aria-label') ?? '';
  return want ? label.endsWith(`from ${want}`) && a.querySelector('img') : label === 'Direct Messages' && !a.querySelector('img');
}, name, { timeout: 10000 });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol');
  const bob = await signUp(browser, 'bob');
  const b = bob.page;

  // Bob waits in a guild of his own, so no chat is open.
  const own = await api(b, 'POST', '/guilds', { name: 'Elsewhere' });
  const ownId = own.id ?? own.guild?.id;
  await b.goto(`${BASE}/guild/${ownId}`);
  await b.waitForSelector('#dm-input');
  await waitForButton(b, null);
  check(true, 'nothing unread: the DM icon');

  await openChat(alice.page, bob.id);
  await send(alice.page, 'hi from alice');
  await waitForButton(b, alice.name);
  check(true, "a DM: the sender's picture, live");
  const box = await button(b).boundingBox();
  check(Math.round(box.width) === 48 && Math.round(box.height) === 48, 'the picture fills the 48px button');
  if (dir) await b.locator('.sidebar').screenshot({ path: `${dir}/rail-unread.png` });

  await openChat(carol.page, bob.id);
  await send(carol.page, 'hi from carol');
  await waitForButton(b, carol.name);
  check(true, 'a newer DM from someone else: their picture');

  await b.reload();
  await b.waitForSelector('#dm-input');
  await waitForButton(b, carol.name);
  check(true, 'after a reload: still the newest sender');

  await openChat(b, carol.id);
  await waitForButton(b, alice.name);
  check(true, "reading the newest: the one before's picture");

  await openChat(b, alice.id);
  await waitForButton(b, null);
  check(true, 'all read: the DM icon again');

  // A phone: the rail beside a guild's channel list.
  const dave = await signUp(browser, 'dave', { ...devices['Pixel 7'] });
  const p = dave.page;
  const daves = await api(p, 'POST', '/guilds', { name: 'Phone' });
  await p.goto(`${BASE}/guild/${daves.id ?? daves.guild?.id}`);
  await waitForButton(p, null);
  await openChat(alice.page, dave.id);
  await send(alice.page, 'hi dave');
  await waitForButton(p, alice.name);
  check(true, 'phone: the picture too');
  if (dir) {
    // A quick flick right shows the list (and the rail).
    const cdp = await p.context().newCDPSession(p);
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }] });
    await touch('touchStart', 40);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', 40 + i * 50); await p.waitForTimeout(16); }
    await touch('touchEnd');
    await cdp.detach();
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${dir}/rail-phone.png` });
  }
  console.log('dmrail: ok');
} catch (err) {
  console.error('dmrail: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
