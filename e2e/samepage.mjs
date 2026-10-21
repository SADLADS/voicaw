// Clicking where you already are on the rail (the DMs button in a DM, the open guild's icon)
// does nothing: no navigation to bare /dm or /guild/:id and back (which flashed an empty page),
// the chat on screen stays the same element. Other icons still navigate. Desktop and phone.
//   node e2e/serve.mjs &   then   node e2e/samepage.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const pane = (page) => page.evaluate(() => {
  const w = document.querySelector('.main-wrapper');
  if (!w) return 'none';
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'none';
});
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });
  await page.waitForTimeout(150);
};
const path = (page) => page.evaluate(() => location.pathname);
// Counts every navigation from now on, and tags the element given so we can tell whether it
// was replaced.
const watch = (page, selector) => page.evaluate((sel) => {
  window.__navs = [];
  if (!window.__navWatch) {
    window.__navWatch = true;
    navigation.addEventListener('navigate', (e) => window.__navs.push(new URL(e.destination.url).pathname));
  }
  document.querySelector(sel).__samepage = true;
}, selector);
const result = (page, selector) => page.evaluate((sel) => ({
  navs: window.__navs,
  same: Boolean(document.querySelector(sel)?.__samepage),
}), selector);
const click = async (page, name) => {
  await page.getByRole('link', { name, exact: true }).click();
  await page.waitForTimeout(600);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await makeFriends(alice, bob);
  const one = await api(alice.page, 'POST', '/guilds', { name: 'One' });
  const two = await api(alice.page, 'POST', '/guilds', { name: 'Two' });
  const invite = await api(alice.page, 'POST', `/guilds/${one.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello');
  await alice.page.waitForSelector('text=hello');

  // Desktop, in a DM: the DMs button.
  const a = alice.page;
  const dmPath = await path(a);
  await watch(a, '.main-content-wrapper > *');
  await click(a, 'Direct Messages');
  let r = await result(a, '.main-content-wrapper > *');
  check(r.navs.length === 0 && r.same && (await path(a)) === dmPath, `DMs button in a DM: stays (${JSON.stringify(r.navs)})`);

  // Desktop, in a guild channel: its icon.
  await click(a, 'One');
  await a.waitForURL(/\/guild\/\d+\/\d+/);
  await a.waitForSelector('#guild-main:not([aria-busy])');
  const channelPath = await path(a);
  await watch(a, '#guild-main');
  await click(a, 'One');
  r = await result(a, '#guild-main');
  check(r.navs.length === 0 && r.same && (await path(a)) === channelPath, `guild icon in that guild: stays (${JSON.stringify(r.navs)})`);
  await shot(a, 'desktop-guild');

  // Other icons still work.
  await click(a, 'Two');
  check((await path(a)).startsWith(`/guild/${two.id}/`), 'another guild opens');
  await click(a, 'Direct Messages');
  check((await path(a)).startsWith('/dm/'), 'DMs button from a guild opens the DMs');

  // Phone, on the guild's list pane: tapping its icon leaves the list as it is.
  const b = await bob.page.context().newPage();
  await b.goto(`${BASE}/guild/${one.id}/${one.channels[0].id}`);
  await b.waitForSelector('#dm-input');
  await settle(b);
  await b.evaluate(() => history.back());
  await b.waitForTimeout(300);
  await settle(b);
  check(await pane(b) === 'list', 'phone: Back shows the channel list');
  const phonePath = await path(b);
  await watch(b, '.main-content-wrapper > *');
  await b.tap(`.rail-guild[href="/guild/${one.id}"]`);
  await b.waitForTimeout(600);
  r = await result(b, '.main-content-wrapper > *');
  check(r.navs.length === 0 && r.same && (await path(b)) === phonePath && await pane(b) === 'list',
    `phone: guild icon in that guild stays on its list (${JSON.stringify(r.navs)})`);
  await b.tap('.nav-icon[aria-label="Direct Messages"]');
  await b.waitForURL('**/dm**');
  await settle(b);
  check((await path(b)).startsWith('/dm'), 'phone: DMs button from a guild opens the DMs');
  await shot(b, 'phone-dms');
} catch (err) {
  console.error('samepage: FAILED', err.message.split('\n')[0]);
  failures++;
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
