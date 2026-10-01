// Themes: Settings → Appearance switches light/dark at once, it's remembered on this device only
// (after a reload, not in another browser), "Match system" follows the system, and the page's
// color-scheme (the browser's own controls and scrollbars) follows. Screenshots of the main screens in both themes, computer and phone.
//   node e2e/serve.mjs &   then   node e2e/themes.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

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
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// What the page says about its theme: <html data-theme>, the color-scheme the message box
// really uses (the browser's own controls) and the page's background.
const themeOf = (page) => page.evaluate(() => {
  const input = document.querySelector('#dm-input') || document.body;
  return {
    theme: document.documentElement.dataset.theme,
    bs: document.documentElement.dataset.bsTheme,
    scheme: getComputedStyle(input).colorScheme,
    bg: getComputedStyle(document.body).backgroundColor,
  };
});
const isLightBg = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (r + g + b) / 3 > 180;
};

const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;

  // Something to look at: a DM with markdown, a code block, a mention, a reply and a reaction.
  await openChat(a, bob.id);
  await openChat(bob.page, alice.id);
  await send(a, 'Hello **bold**, *italic*, __underline__, `code`, ||spoiler|| and https://example.com');
  await bob.page.waitForSelector('text=Hello');
  await bob.page.click('#dm-input');
  await bob.page.keyboard.type('> a quote');
  await bob.page.keyboard.press('Enter');
  await bob.page.keyboard.type('```js');
  await bob.page.keyboard.down('Shift');
  await bob.page.keyboard.press('Enter');
  await bob.page.keyboard.up('Shift');
  await bob.page.keyboard.type('const answer = 42; // "highlighted"');
  await bob.page.keyboard.down('Shift');
  await bob.page.keyboard.press('Enter');
  await bob.page.keyboard.up('Shift');
  await bob.page.keyboard.type('```');
  await bob.page.keyboard.press('Enter');
  await a.waitForSelector('.hljs');

  // And a guild with a coloured role, a few channels and a mention of alice.
  const guild = await api(a, 'POST', '/guilds', { name: 'Theme Test' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(a, 'POST', `/guilds/${guildId}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  const role = await api(a, 'POST', `/guilds/${guildId}/roles`, { name: 'Mods', color: 0xe67e22, hoist: true });
  await api(a, 'PUT', `/guilds/${guildId}/members/${bob.id}/roles`, { roleIds: [role.id ?? role.role?.id] });
  await api(a, 'POST', `/guilds/${guildId}/channels`, { name: 'random', type: 'text' });
  await api(a, 'POST', `/guilds/${guildId}/channels`, { name: 'Lounge', type: 'voice' });
  await bob.page.goto(`${BASE}/guild/${guildId}`);
  await bob.page.waitForSelector('#dm-input');
  await bob.page.click('#dm-input');
  await bob.page.keyboard.type(`hey @${alice.name.slice(0, 5)}`);
  await bob.page.waitForSelector('.mention-suggestions');
  await bob.page.keyboard.press('Enter');
  await bob.page.keyboard.type(' welcome :)');
  await bob.page.keyboard.press('Enter');

  // Default: dark, as before.
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('#dm-input');
  let t = await themeOf(a);
  check(t.theme === 'dark' && t.scheme === 'dark' && !isLightBg(t.bg), `dark by default (${JSON.stringify(t)})`);

  // Settings → Appearance → Light: changes at once.
  await a.goto(`${BASE}/settings#appearance`);
  await a.waitForSelector("#settings-appearance");
  await shot(a, 'settings-dark');
  await a.click('#settings-appearance >> text=Light');
  t = await themeOf(a);
  check(t.theme === 'light' && t.bs === 'light' && t.scheme === 'light' && isLightBg(t.bg), `Light switches at once (${JSON.stringify(t)})`);
  await shot(a, 'settings-light');

  // Remembered on this device: after a reload, set before anything is drawn.
  await a.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__themeAtLoad = document.documentElement.dataset.theme;
    });
  });
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('#dm-input');
  t = await themeOf(a);
  check(t.theme === 'light' && t.scheme === 'light', 'still light after a reload; the message box is color-scheme light');
  check((await a.evaluate(() => window.__themeAtLoad)) === 'light', 'set before the app loads (no dark flash)');
  check((await a.evaluate(() => localStorage.getItem('theme'))) === 'light', 'kept in localStorage');
  await a.waitForSelector('.hljs');
  await shot(a, 'dm-light');

  // Not the account's: bob (another browser) is still dark.
  t = await themeOf(bob.page);
  check(t.theme === 'dark', 'another browser keeps its own theme');

  // Guild, with the member list and a menu open.
  await a.goto(`${BASE}/guild/${guildId}`);
  await a.waitForSelector('#dm-input');
  await a.waitForSelector('text=welcome');
  await shot(a, 'guild-light');
  await a.click('.guild-header-button');
  await a.waitForTimeout(300);
  await shot(a, 'guild-menu-light');
  await a.keyboard.press('Escape');
  await a.mouse.click(700, 400);

  // Emoji picker.
  await a.click('#dm-input');
  await a.click('.emoji-button');
  await a.waitForTimeout(800);
  await shot(a, 'emoji-light');
  await a.keyboard.press('Escape');

  // Match system: follows the system's setting, live.
  await a.goto(`${BASE}/settings#appearance`);
  await a.waitForSelector("#settings-appearance");
  await a.emulateMedia({ colorScheme: 'dark' });
  await a.click('#settings-appearance >> text=Match system');
  check((await themeOf(a)).theme === 'dark', 'Match system with a dark system: dark');
  await a.emulateMedia({ colorScheme: 'light' });
  await a.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  check(true, 'and turns light when the system does, without a reload');
  check((await a.evaluate(() => localStorage.getItem('theme'))) === 'system', 'stored as "system"');

  // Dark again, for the dark screenshots.
  await a.click('#settings-appearance >> text=Dark');
  check((await themeOf(a)).theme === 'dark', 'Dark switches back');
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('.hljs');
  await shot(a, 'dm-dark');
  await a.goto(`${BASE}/guild/${guildId}`);
  await a.waitForSelector('text=welcome');
  await shot(a, 'guild-dark');

  // Phone, light: the chat, and the list underneath.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(`${BASE}/`);
  await p.evaluate(() => localStorage.setItem('theme', 'light'));
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.keyboard.press('Enter');
  await p.waitForSelector('#dm-main, .dm-sidebar', { timeout: 20000 });
  await shot(p, 'login-phone-light');
  await p.goto(`${BASE}/dm/${bob.id}`);
  await p.waitForSelector('.hljs');
  t = await themeOf(p);
  check(t.theme === 'light' && t.scheme === 'light', 'phone: light, message box color-scheme light');
  await shot(p, 'dm-phone-light');
  await p.goBack();
  await p.waitForTimeout(600);
  await shot(p, 'list-phone-light');

  console.log('themes: ok');
} catch (err) {
  console.error('themes: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
