// Phone Back button, as in Discord's app (utils/phoneHistory.js, hooks/useSwipePanes.js): from
// a chat it shows the list (of that chat's guild, or the DMs), from the list it leaves the app;
// it never goes through guilds or chats seen before. A guild on the rail, a channel link in a
// message, the DMs button: none add a history entry. Settings still closes with Back.
//   node e2e/serve.mjs &   then   node e2e/back.mjs [screenshot dir]
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
const canGoBack = (page) => page.evaluate(() => navigation.canGoBack);
const path = (page) => page.evaluate(() => location.pathname);
// Android's back button (or gesture): the WebView goes back in its history.
const back = async (page) => {
  await page.evaluate(() => history.back());
  await page.waitForTimeout(300);
  await settle(page);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await makeFriends(alice, bob);
  const one = await api(bob.page, 'POST', '/guilds', { name: 'One' });
  const two = await api(bob.page, 'POST', '/guilds', { name: 'Two' });
  const invite = await api(bob.page, 'POST', `/guilds/${one.id}/invites`, {});
  await api(alice.page, 'POST', `/invites/${invite.code}`);
  await openChat(alice.page, bob.id);
  await send(alice.page, `meet in <#${one.channels[0].id}>`);

  // A new tab, as if the app had just been opened on this chat.
  const page = await bob.page.context().newPage();
  page.on('pageerror', (e) => console.log('[bob] page error:', e.message));
  await page.goto(`${BASE}/guild/${two.id}/${two.channels[0].id}`);
  await page.waitForSelector('#dm-input');
  await settle(page);
  check(await pane(page) === 'content', 'opens on the chat');

  await back(page);
  check(await pane(page) === 'list', 'Back shows the channel list');
  check(!(await canGoBack(page)), 'and Back again would leave the app');

  // Guilds on the rail: no entries.
  await page.tap(`.rail-guild[href="/guild/${one.id}"]`);
  await page.waitForURL(`**/guild/${one.id}/**`);
  await settle(page);
  check(await pane(page) === 'list', 'a guild on the rail shows its channels');
  await page.tap(`.rail-guild[href="/guild/${two.id}"]`);
  await page.waitForURL(`**/guild/${two.id}/**`);
  await settle(page);
  check(!(await canGoBack(page)), 'switching guilds adds nothing to go back through');

  // A channel, then Back: the list again, then out.
  await page.tap('.guild-channel-link');
  await settle(page);
  check(await pane(page) === 'content', 'a channel opens');
  await shot(page, '1-channel');
  await back(page);
  check(await pane(page) === 'list' && (await path(page)).startsWith(`/guild/${two.id}`), 'Back shows that guild\'s channels');
  check(!(await canGoBack(page)), 'and nothing before it');

  // The DMs, a DM, a channel link in it: Back shows the linked guild's channels, not the DM.
  await page.tap('.nav-icon[href="/dm"]');
  await page.waitForURL('**/dm**');
  await settle(page);
  check(!(await canGoBack(page)), 'the DMs button adds nothing either');
  await page.tap(`.dm-user[href="/dm/${alice.id}"]`);
  await settle(page);
  check(await pane(page) === 'content', 'a DM opens');
  const link = await page.waitForSelector('.dm-message-content .channel-mention:not(.unknown)', { timeout: 15000 });
  await link.tap();
  await page.waitForURL(`**/guild/${one.id}/${one.channels[0].id}`);
  await settle(page);
  check(await pane(page) === 'content', 'the channel link opens the channel');
  await back(page);
  check(await pane(page) === 'list', 'Back from it shows the list');
  check((await path(page)).startsWith(`/guild/${one.id}`), `of the linked channel's guild (${await path(page)})`);
  await shot(page, '2-linked-guild-list');
  check(!(await canGoBack(page)), 'and Back again would leave the app, not go back to the DM');

  // The header's back arrow rather than Back: the same.
  await page.tap('.nav-icon[href="/dm"]');
  await settle(page);
  await page.tap(`.dm-user[href="/dm/${alice.id}"]`);
  await settle(page);
  await (await page.waitForSelector('.dm-message-content .channel-mention:not(.unknown)')).tap();
  await page.waitForURL(`**/guild/${one.id}/**`);
  await settle(page);
  await page.tap('.pane-back-button');
  await page.waitForTimeout(300);
  await settle(page);
  check(await pane(page) === 'list' && (await path(page)).startsWith(`/guild/${one.id}`), 'the header\'s back arrow does the same');

  // Settings is a screen of its own: Back closes it.
  await page.tap('.user-panel-settings');
  await page.waitForURL('**/settings');
  await back(page);
  check((await path(page)).startsWith(`/guild/${one.id}`) && await pane(page) === 'list', 'Back closes Settings');
  check(!(await canGoBack(page)), 'leaving nothing behind');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
