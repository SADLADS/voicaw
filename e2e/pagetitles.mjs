// Page titles: the tab's title (and the desktop app's window title) follows the page: Direct
// Messages, Friends, Notes, Settings, the guild's name, the developer portal; a DM never names
// who it's with.
//   node e2e/serve.mjs &   then   node e2e/pagetitles.mjs
import { launchChrome, signUp, openChat, BASE } from './helpers.mjs';

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const titled = async (page, want, what) => {
  await page.waitForFunction((w) => document.title === w, want, { timeout: 10000 })
    .catch(async () => { throw new Error(`${what}: title is "${await page.title()}", wanted "${want}"`); });
  console.log(`  ok: ${what} = "${want}"`);
};

// Moves within the app (no reload), as clicking does.
const go = (page, path) => page.evaluate((p) => {
  window.history.pushState({}, '', p);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, path);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;

  await a.goto(`${BASE}/dm`);
  await titled(a, 'Friends', '/dm (opens on Friends)');
  await openChat(a, bob.id);
  await titled(a, 'Direct Messages', 'a DM');
  await go(a, '/dm/notes');
  await titled(a, 'Notes', 'notes');

  const guild = await api(a, 'POST', '/guilds', { name: 'Book club' });
  const guildId = guild.id ?? guild.guild?.id;
  await go(a, `/guild/${guildId}`);
  await titled(a, 'Book club', 'a guild');
  await a.goto(`${BASE}/guild/${guildId}`);
  await titled(a, 'Book club', 'a guild after a reload');

  await go(a, '/settings');
  await titled(a, 'Settings', 'settings');
  await a.goto(`${BASE}/developers`);
  await titled(a, 'Developer Portal', 'developer portal');

  const fresh = await browser.newPage();
  await fresh.goto(BASE);
  await titled(fresh, 'Voicaw', 'logged out');
  console.log('page titles: all ok');
} finally {
  await browser.close();
}
