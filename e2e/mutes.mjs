// Muted channels: right-click a channel → Mute, it's dimmed; its messages don't mark it (or the
// guild's icon) unread, but a mention of you still shows; the header bell unmutes it (saying
// until when); a phone mutes from the header bell.
//   node e2e/serve.mjs &   then   node e2e/mutes.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

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
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Quiet' });
  const general = guild.channels[0];
  const random = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'random' });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);
  const say = (channel, content) => api(alice.page, 'POST', `/channels/${channel.id}/messages`, { content });

  // Bob mutes #random from the channel list.
  const b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  const randomRow = () => b.locator('.guild-channel', { has: b.locator('.guild-channel-name', { hasText: 'random' }) });
  await randomRow().locator('.guild-channel-link').click({ button: 'right' });
  await b.waitForSelector('.channel-mute-menu');
  await shot(b, 'menu');
  await b.click('.channel-mute-menu >> text=For 1 hour');
  await b.waitForSelector('.guild-channel.muted');
  check(await randomRow().evaluate((el) => el.classList.contains('muted')), '#random shows as muted');
  check(await randomRow().locator('[aria-label="Muted"]').count() === 1, 'with a crossed-out bell');
  check(!(await b.$('.channel-mute-menu')), 'the menu closed');

  // Away from the guild: a message in #random doesn't light the guild up.
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('#dm-main');
  await say(random, 'nobody needs to see this');
  await pause(1500);
  const railDot = () => b.locator('.nav-item', { has: b.locator(`[aria-label="Quiet"]`) }).locator('.dot');
  check(!(await railDot().evaluate((el) => el.classList.contains('visible'))), 'no unread dot on the guild for a muted channel');
  // A mention of him still shows.
  await say(random, `hey <@${bob.id}>`);
  await b.waitForSelector('.rail-mention-badge', { timeout: 10000 });
  check((await b.textContent('.rail-mention-badge')) === '1', 'a mention in the muted channel still counts on the guild');
  await shot(b, 'rail');

  // In the guild: #random isn't bold, but has its mention count.
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  check(!(await randomRow().evaluate((el) => el.classList.contains('unread'))), "#random isn't marked unread");
  check((await randomRow().locator('.mention-badge').textContent()) === '1', 'but shows the mention');
  const opacity = await randomRow().locator('.guild-channel-name').evaluate((el) => getComputedStyle(el).opacity);
  const badgeOpacity = await randomRow().locator('.mention-badge').evaluate((el) => getComputedStyle(el).opacity);
  check(Number(opacity) < 0.6 && badgeOpacity === '1', `its name is dimmed (${opacity}), not the badge`);
  await b.mouse.move(600, 400);
  await shot(b, 'sidebar');

  // The header bell unmutes it, saying until when.
  await randomRow().locator('.guild-channel-link').click();
  await b.waitForSelector('.mute-button[aria-label="Unmute channel"]');
  await b.click('.mute-button');
  const until = await b.textContent('.channel-mute-until');
  check(/^Muted until \d{1,2}:\d{2}/.test(until), `the menu says "${until}"`);
  await shot(b, 'header-menu');
  await b.click('.channel-mute-menu >> text=Unmute Channel');
  await b.waitForSelector('.mute-button[aria-label="Mute channel"]');
  check(!(await b.$('.guild-channel.muted')), 'unmuted');
  // Clicking the bell again toggles the menu closed.
  await b.click('.mute-button');
  await b.waitForSelector('.channel-mute-menu');
  await b.click('.mute-button');
  check(!(await b.$('.channel-mute-menu')), 'the bell closes its menu again');

  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  await say(random, 'now you see me');
  await b.waitForFunction(() => [...document.querySelectorAll('.guild-channel.unread .guild-channel-name')].some((e) => e.textContent === 'random'), null, { timeout: 10000 });
  check(true, 'unmuted, #random is marked unread again');

  // Carol, on a phone, mutes #general from the header.
  const c = carol.page;
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('#dm-input');
  await c.tap('.mute-button');
  await c.waitForSelector('.channel-mute-menu');
  const box = await c.locator('.channel-mute-menu').boundingBox();
  const width = c.viewportSize().width;
  check(box.x >= 0 && box.x + box.width <= width, `the menu fits the phone's screen (${Math.round(box.x)}–${Math.round(box.x + box.width)} of ${width})`);
  await shot(c, 'phone-menu');
  await c.tap('.channel-mute-menu >> text=Until I turn it back on');
  await c.waitForSelector('.mute-button[aria-label="Unmute channel"]');
  check(await c.locator('.guild-channel.muted .guild-channel-name', { hasText: 'general' }).count() === 1, "#general is muted in carol's channel list");
  await c.tap('.mute-button');
  check((await c.textContent('.channel-mute-until')) === 'Muted until you unmute it', 'and stays muted until she unmutes it');
  await shot(c, 'phone-muted');

  console.log('mutes: ok');
} catch (err) {
  console.error('mutes: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
