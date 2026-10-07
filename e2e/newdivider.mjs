// The "New" divider (Discord's red line above the first unread message): in a DM and a guild
// channel when opened with unread messages, gone once you send one, none when nothing's unread,
// moved to the first message that comes while the window is in the background; phone.
//   node e2e/serve.mjs &   then   node e2e/newdivider.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, makeFriends, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

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

// What the divider sits above (the text of its row), or null without one.
const dividerAbove = (page) => page.evaluate(() => {
  const dividers = document.querySelectorAll('.message-scroller .new-divider');
  if (dividers.length > 1) return `${dividers.length} dividers`;
  const row = dividers[0]?.parentElement;
  return row ? row.querySelector('.dm-message-content')?.textContent.trim() ?? '(no text)' : null;
});
// Whether the row with that text starts a group (shows its author's name).
const showsAuthor = (page, text) => page.locator('[data-key]', { hasText: text }).last()
  .evaluate((row) => Boolean(row.querySelector('.message-author')));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await makeFriends(alice, bob);
  const a = alice.page;
  const b = bob.page;

  // DM: Bob reads "earlier", then Alice writes two more while he's elsewhere.
  await openChat(a, bob.id);
  await send(a, 'earlier');
  await openChat(b, alice.id);
  await b.waitForSelector('text=earlier');
  check(await dividerAbove(b) === 'earlier', 'DM: first visit, the message was unread');
  await b.goto(`${BASE}/dm/friends`);
  await b.waitForTimeout(800); // somewhere that isn't a chat (/dm reopens the last one)
  await send(a, 'first new one');
  await send(a, 'second new one');
  await b.waitForTimeout(500);
  await openChat(b, alice.id);
  await b.waitForSelector('text=second new one');
  check(await dividerAbove(b) === 'first new one', 'DM: divider above the first unread message');
  check(await showsAuthor(b, 'first new one'), 'DM: which starts a group of its own');
  check(await b.locator('.new-divider-pill').textContent() === 'New', 'DM: with "New" at the end of the line');
  await shot(b, 'dm-desktop');
  // Live messages while looking don't move it; replying takes it away.
  await send(a, 'third, seen live');
  await b.waitForSelector('text=third, seen live');
  check(await dividerAbove(b) === 'first new one', 'DM: a live message leaves it where it was');
  await send(b, 'answering');
  await b.waitForFunction(() => !document.querySelector('.new-divider'));
  check(true, 'DM: sending a message takes it away');
  // Reopening: everything was read.
  await b.goto(`${BASE}/dm/friends`);
  await openChat(b, alice.id);
  await b.waitForSelector('text=answering');
  check(await dividerAbove(b) === null, 'DM: reopened with nothing unread, no divider');

  // In the background: the first message that comes moves the divider there.
  await b.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event('blur'));
  });
  await send(a, 'while you were away');
  await b.waitForSelector('text=while you were away');
  await send(a, 'and another');
  await b.waitForSelector('text=and another');
  check(await dividerAbove(b) === 'while you were away', 'DM: divider above the first message that came in the background');

  // A guild channel (each visit loads the app afresh, as on starting it).
  const guild = await api(a, 'POST', '/guilds', { name: 'Divided' });
  const general = guild.channels[0];
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  const say = (content) => api(a, 'POST', `/channels/${general.id}/messages`, { content });
  await say('channel history');
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('text=channel history');
  check(await dividerAbove(b) === 'channel history', 'channel: first visit, its message was unread');
  await b.goto(`${BASE}/dm/friends`);
  await b.waitForTimeout(800); // somewhere that isn't a chat (/dm reopens the last one)
  await say('channel news');
  await say('more channel news');
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('text=more channel news');
  check(await dividerAbove(b) === 'channel news', 'channel: divider above the first unread message');
  await shot(b, 'channel-desktop');

  // Phone.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await makeFriends(alice, carol);
  await openChat(a, carol.id);
  await send(a, 'hello phone');
  await send(a, 'are you there?');
  await openChat(carol.page, alice.id);
  await carol.page.waitForSelector('text=are you there?');
  check(await dividerAbove(carol.page) === 'hello phone', 'phone: divider above the first unread message');
  const fits = await carol.page.$eval('.new-divider', (el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && r.height > 0 && r.height < 30;
  });
  check(fits, 'phone: the line fits the screen');
  await shot(carol.page, 'dm-phone');

  console.log('newdivider: ok');
} catch (err) {
  console.error('newdivider: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
