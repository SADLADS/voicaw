// Page titles on the web, as Discord's: "Voicaw | @name" in a DM, "Voicaw | #channel | Guild",
// "Voicaw | Friends", "Voicaw | Settings"; the developer portal; logged out just "Voicaw". (The
// desktop app's plain titles are in usePageTitle.test.js.)
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
  await titled(a, 'Voicaw | Friends', '/dm (opens on Friends)');
  await openChat(a, bob.id);
  await titled(a, `Voicaw | @${bob.name}`, 'a DM');
  await go(a, '/dm/notes');
  await titled(a, 'Voicaw | Notes', 'notes');

  const guild = await api(a, 'POST', '/guilds', { name: 'Book club' });
  const guildId = guild.id ?? guild.guild?.id;
  await go(a, `/guild/${guildId}`);
  await titled(a, 'Voicaw | #general | Book club', 'a guild');
  await a.goto(`${BASE}/guild/${guildId}`);
  await titled(a, 'Voicaw | #general | Book club', 'a guild after a reload');

  await go(a, '/settings');
  await titled(a, 'Voicaw | Settings', 'settings');
  await a.goto(`${BASE}/developers`);
  await titled(a, 'Voicaw | Developer Portal', 'developer portal');

  const fresh = await browser.newPage();
  await fresh.goto(BASE);
  await titled(fresh, 'Voicaw', 'logged out');
  console.log('page titles: all ok');
} finally {
  await browser.close();
}
