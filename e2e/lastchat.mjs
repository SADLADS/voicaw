// Reopening the app on the last chat: Alice's DM with Bob, then a guild channel, each come back
// when the app is opened again at / (Settings and Friends in between don't count); a guild
// deleted while the app was closed goes to the DMs instead; Bob's phone reopens on the chat
// itself (not the list).
//   node e2e/serve.mjs &   then   node e2e/lastchat.mjs [screenshot dir]
import { launchChrome, signUp, devices, makeFriends, openChat, send, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

const call = (page, method, path) => page.evaluate(async ({ method, path }) => {
  const res = await fetch(`/api${path}`, { method, headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  return res.status;
}, { method, path });

// Opens the app fresh at / (as the PWA, the desktop and Android apps do) and waits until it has
// settled on a page.
async function reopen(page, settledOn) {
  await page.goto(`${BASE}/`);
  await page.waitForURL((url) => settledOn.test(url.pathname), { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  return new URL(page.url()).pathname;
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob);
  const a = alice.page;
  const b = bob.page;

  // A DM.
  await openChat(a, bob.id);
  await send(a, 'hello bob');
  await a.goto(`${BASE}/settings/profile`);
  await a.waitForLoadState('networkidle');
  check(await reopen(a, /^\/dm\/\d+$/) === `/dm/${bob.id}`, 'reopens on the DM (Settings after it ignored)');
  await a.waitForSelector('#dm-input');

  // A guild channel.
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Last Chat Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const channelPath = new URL(a.url()).pathname;
  const guildId = channelPath.split('/')[2];
  await a.goto(`${BASE}/dm/friends`);
  await a.waitForLoadState('networkidle');
  check(await reopen(a, /^\/guild\/\d+\/\d+$/) === channelPath, 'reopens on the guild channel (Friends after it ignored)');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await shot(a, 'guild');

  // The guild deleted while the app was closed: the DMs instead (the latest conversation).
  check(await call(a, 'DELETE', `/guilds/${guildId}`) < 300, 'guild deleted');
  await a.goto('about:blank');
  check(await reopen(a, /^\/dm\/\d+$/) === `/dm/${bob.id}`, 'a deleted guild reopens on the DMs');
  check(await a.evaluate(() => localStorage.getItem('lastChat')) === `/dm/${bob.id}`, 'and the DM it landed on is remembered instead');

  // Phone: the chat, not the list.
  await openChat(b, alice.id);
  check(await reopen(b, /^\/dm\/\d+$/) === `/dm/${alice.id}`, 'phone reopens on the DM');
  await b.waitForSelector('#dm-input', { state: 'visible' });
  await b.waitForTimeout(500);
  check(await b.evaluate(() => document.querySelector('.pane-content') != null), 'phone shows the chat pane');
  await shot(b, 'phone');

  console.log('lastchat: ok');
} catch (err) {
  console.error('lastchat: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
