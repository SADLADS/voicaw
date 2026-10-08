// Friends (server/friends.js, client Friends.jsx): a new account's DM list has no one (landing on
// /dm opens the Friends page); Add friend by username, the request live on the other side
// (rail dot, count on the Friends row, Pending), Accept = both lists gain each other; Add Friend
// / Cancel Friend Request / Remove Friend in a person's right-click menu; a non-friend's first DM puts them in
// the list live; admins' Everyone tab; Remove friend (asks); phone.
//   node e2e/serve.mjs &   then   node e2e/friends.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { join } from 'path';
import { BASE, devices, launchChrome, signUp, openChat, send } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: join(dir, `${name}.png`) }) : null);
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, path, body]);
const rowFor = (page, name) => page.locator('.dm-user-list-container .dm-user', { hasText: name });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  // New accounts: nobody in the list, and /dm opens Friends.
  await a.goto(`${BASE}/dm`);
  await a.waitForURL(/\/dm\/friends$/);
  check(await a.waitForSelector('.friends-main').then(() => true, () => false), '/dm with no conversations opens the Friends page');
  check(await rowFor(a, bob.name).count() === 0, "bob isn't in alice's DM list");
  await b.goto(`${BASE}/dm/friends`);
  await b.waitForSelector('.friends-main');

  // Alice adds Bob by username (any capitals).
  await a.click('.friends-tab:has-text("Add friend")');
  await a.fill('.friends-add input', bob.name.toUpperCase());
  await a.click('button:has-text("Send friend request")');
  await a.waitForSelector(`text=Friend request sent to ${bob.name.toUpperCase()}.`);
  await shot(a, 'add-friend');

  // Bob sees it live: rail dot, count on the Friends row and the Pending tab.
  await b.waitForSelector('.dm-friends-link .friends-badge:has-text("1")', { timeout: 10000 });
  check(await b.isVisible('.friends-tab:has-text("Pending") .friends-badge'), 'Pending tab shows the count');
  await b.click('.friends-tab:has-text("Pending")');
  await b.waitForSelector(`.friends-row:has-text("Sent you a friend request")`);
  await shot(b, 'pending');
  await a.click('.friends-tab:has-text("Pending")');
  check(await a.isVisible('.friends-row:has-text("Friend request sent")'), "alice's Pending shows her request");

  await b.click('.friends-row button[aria-label="Accept"]');
  await b.waitForSelector('text=No friend requests.');
  check(await b.locator('.dm-friends-link .friends-badge').count() === 0, 'count gone once accepted');
  await rowFor(b, alice.name).waitFor({ timeout: 10000 });
  await rowFor(a, bob.name).waitFor({ timeout: 10000 });
  check(true, 'both DM lists gain each other live');
  await b.click('.friends-tab:has-text("All")');
  await b.waitForSelector(`.friends-row:has-text("${alice.name}")`);
  await shot(b, 'all-friends');

  // A row opens the DM.
  await b.click(`.friends-row:has-text("${alice.name}")`);
  await b.waitForURL(new RegExp(`/dm/${alice.id}$`));
  await b.waitForSelector('#dm-input');
  check(true, 'clicking a friend opens the DM');

  // Carol (not a friend) DMs Alice: she joins Alice's list with that first message.
  const carol = await signUp(browser, 'carol');
  const c = carol.page;
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('#dm-input');
  await openChat(c, alice.id);
  await send(c, 'hi, we met in the guild');
  await rowFor(a, carol.name).waitFor({ timeout: 10000 });
  check(true, "a non-friend's first DM puts them in the list live");

  // A person's right-click menu (a message's author): Add Friend → Cancel Friend Request →
  // (Alice accepts) Remove Friend.
  const guild = (await api(a, 'POST', '/guilds', { name: 'Hangout' })).body;
  const channel = guild.channels[0];
  const invite = (await api(a, 'POST', `/guilds/${guild.id}/invites`, {})).body;
  await api(c, 'POST', `/invites/${invite.code}`);
  await api(a, 'POST', `/channels/${channel.id}/messages`, { content: 'welcome!' });
  await c.goto(`${BASE}/guild/${guild.id}/${channel.id}`);
  await c.waitForSelector('text=welcome!');
  const authorMenu = async () => {
    await c.click(`.message-author:has-text("${alice.name}")`, { button: 'right' });
    await c.waitForSelector('.context-menu');
    return c.$$eval('.context-menu [role^="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));
  };
  check((await authorMenu()).includes('Add Friend'), 'the menu offers Add Friend');
  await c.click('.context-menu >> text=Add Friend');
  await c.waitForSelector('.context-menu', { state: 'detached' });
  check((await authorMenu()).includes('Cancel Friend Request'), 'then Cancel Friend Request');
  await shot(c, 'menu-request-sent');
  await c.keyboard.press('Escape');
  await a.waitForSelector('.dm-friends-link .friends-badge:has-text("1")', { timeout: 10000 });
  await api(a, 'PUT', `/friends/${carol.id}`);
  for (let i = 0; i < 20; i += 1) {
    const items = await authorMenu();
    await c.keyboard.press('Escape');
    if (items.includes('Remove Friend')) break;
    if (i === 19) throw new Error(`no Remove Friend: ${items}`);
    await c.waitForTimeout(500);
  }
  check(true, 'the menu follows: Add Friend → Cancel Friend Request → Remove Friend');

  // Removing asks first; the conversation stays in the list.
  await a.goto(`${BASE}/dm/friends`);
  await a.click('.friends-tab:has-text("All")');
  await a.click(`.friends-row:has-text("${carol.name}") button[aria-label="Remove friend"]`);
  await a.waitForSelector('.vc-dialog:has-text("Remove")');
  await a.click('.vc-dialog button:has-text("Remove friend")');
  await a.waitForSelector(`.friends-row:has-text("${carol.name}")`, { state: 'detached' });
  check(await rowFor(a, carol.name).count() === 1, 'an ex-friend you talked to stays in the DM list');

  // Admins: Everyone lists every account; others don't get the tab.
  check(await a.locator('.friends-tab:has-text("Everyone")').count() === 0, 'no Everyone tab for non-admins');
  const admin = await signUp(browser, 'admin');
  await admin.page.goto(`${BASE}/dm/friends`);
  await admin.page.click('.friends-tab:has-text("Everyone")');
  for (const u of [alice, bob, carol]) await admin.page.waitForSelector(`.friends-row:has-text("${u.name}")`);
  check(true, "admin's Everyone tab lists everyone");
  await shot(admin.page, 'admin-everyone');
  await admin.page.click(`.friends-row:has-text("${bob.name}")`);
  await admin.page.waitForSelector('#dm-input');
  check(true, 'admin opens a DM with anyone from it');

  // Phone: the Friends row, the page and its tabs fit.
  const dee = await signUp(browser, 'dee', { ...devices['Pixel 7'] });
  const d = dee.page;
  await api(a, 'PUT', `/friends/${dee.id}`);
  await d.goto(`${BASE}/dm`);
  // No conversations: the Friends page, on top of the list.
  await d.waitForURL(/\/dm\/friends$/);
  await d.waitForSelector('.friends-row:has-text("Sent you a friend request")');
  await d.tap('.friends-main .pane-back-button');
  await d.waitForSelector('.dm-friends-link .friends-badge:has-text("1")', { timeout: 10000 });
  await d.waitForTimeout(500);
  await shot(d, 'phone-list');
  await d.tap('.dm-friends-link:has-text("Friends")');
  await d.waitForTimeout(500);
  check(await d.isVisible('.friends-tab:has-text("Add friend")'), 'phone: the tabs fit, Add friend included');
  const overflow = await d.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `phone: no sideways scroll (${overflow}px)`);
  await shot(d, 'phone-pending');
  await d.tap('.friends-row button[aria-label="Accept"]');
  await d.waitForSelector('text=No friend requests.');
  check(true, 'phone: accept works');
} catch (err) {
  console.error('friends: FAILED', err.message.split('\n')[0]);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `friends: ${failures} failed` : 'friends: all ok');
process.exitCode = failures ? 1 : 0;
