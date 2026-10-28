// Muted categories: right-click a category → Mute Category → for how long; its channels are
// dimmed and not marked unread (a mention of you still counts), the bell is on the category,
// the guild's rail dot stays off for them (a channel outside it still lights it); the
// menu then says Unmute Category and until when, and unmuting marks them unread again.
//   node e2e/serve.mjs &   then   node e2e/categorymute.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE } from './helpers.mjs';

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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchChrome();
let b;
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Quiet corner' });
  const general = guild.channels[0];
  const loud = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'loud' });
  const category = await api(alice.page, 'POST', `/guilds/${guild.id}/categories`, { name: 'Chatter' });
  const chatter = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'chatter', categoryId: category.id });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  const say = (channel, content) => api(alice.page, 'POST', `/channels/${channel.id}/messages`, { content });

  // Bob mutes the category from its menu, sitting in #loud.
  b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${loud.id}`);
  await b.waitForSelector('#dm-input');
  const header = `.guild-category-header[data-id="${category.id}"]`;
  await b.click(`${header} .guild-category-toggle`, { button: 'right' });
  await b.hover('.context-menu >> text=Mute Category');
  await b.waitForSelector('.context-submenu');
  await shot(b, 'menu');
  await b.click('.context-submenu >> text=For 1 hour');
  await b.waitForSelector('.context-menu', { state: 'detached' });
  const mutes = await api(b, 'GET', '/category-mutes');
  check(mutes.length === 1 && mutes[0].category_id === category.id && mutes[0].until > Date.now() / 1000 + 3500, 'muted for an hour');
  await b.waitForSelector(`${header}.muted .guild-channel-muted`);
  check(true, 'the category shows a crossed-out bell');

  const row = (channel) => b.locator(`.guild-channel[data-id="${channel.id}"]`);
  check(await row(chatter).evaluate((el) => el.classList.contains('muted')), 'its channel is dimmed');
  check(await row(chatter).locator('.guild-channel-muted').count() === 0, 'without a bell of its own');
  check(!(await row(general).evaluate((el) => el.classList.contains('muted'))), 'other categories\' channels are not');

  await say(chatter, 'nobody needs to see this');
  await pause(1500);
  check(!(await row(chatter).evaluate((el) => el.classList.contains('unread'))), 'no unread mark in a muted category');
  await say(chatter, `hey <@${bob.id}>`);
  await row(chatter).locator('.mention-badge').waitFor({ timeout: 10000 });
  check(true, 'a mention still counts');
  await shot(b, 'list');

  // The channel's own menu says its category is muted.
  await row(chatter).locator('.guild-channel-link').click({ button: 'right' });
  const muteItem = b.locator('.context-menu .guild-menu-item', { hasText: 'Mute Channel' });
  check((await muteItem.textContent()).includes('Its category is muted'), 'Mute Channel says the category is muted');
  await b.keyboard.press('Escape');
  await b.waitForSelector('.context-menu', { state: 'detached' });

  // The menu now offers Unmute Category, saying until when.
  await b.click(`${header} .guild-category-toggle`, { button: 'right' });
  const unmute = b.locator('.context-menu .guild-menu-item', { hasText: 'Unmute Category' });
  await unmute.waitFor();
  const text = await unmute.textContent();
  check(/Muted until (.*, )?\d{1,2}:\d{2}/.test(text), `the menu says "${text.replace('Unmute Category', '').trim()}"`);
  await shot(b, 'menu-muted');

  // Unmuted, a new message marks the channel unread.
  await unmute.click();
  await b.waitForSelector('.context-menu', { state: 'detached' });
  check((await api(b, 'GET', '/category-mutes')).length === 0, 'unmuted');
  await b.waitForSelector(`${header}:not(.muted)`);
  check(!(await row(chatter).evaluate((el) => el.classList.contains('muted'))), 'its channel is no longer dimmed');
  await say(chatter, 'now you see me');
  await b.waitForFunction((id) => document.querySelector(`.guild-channel[data-id="${id}"]`)?.classList.contains('unread'), chatter.id, { timeout: 10000 });
  check(true, 'unmuted, the channel is unread again');

  // Muted again, and from another page: the guild's rail dot stays off for its channels.
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('#dm-main');
  await api(b, 'PUT', `/guilds/${guild.id}/categories/${category.id}/mute`, {});
  await api(b, 'POST', `/channels/${chatter.id}/read`, { latest: true });
  await b.reload();
  await b.waitForSelector('#dm-main');
  const icon = '.rail-guild[aria-label="Quiet corner"]';
  const dotLit = () => b.evaluate((sel) => document.querySelector(`.nav-item:has(${sel}) .dot`).classList.contains('visible'), icon);
  await say(chatter, 'still quiet');
  await pause(1500);
  check(!(await dotLit()), 'no rail dot for a muted category');
  await say(loud, 'but this is not');
  await b.waitForFunction((sel) => document.querySelector(`.nav-item:has(${sel}) .dot`)?.classList.contains('visible'), icon, { timeout: 10000 });
  check(true, 'a channel outside it still lights the rail');

  console.log('categorymute: ok');
} catch (err) {
  console.error('categorymute: FAILED', err.message.split('\n')[0]);
  if (b) await shot(b, 'failed').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
