// Muted guilds: right-click a guild's icon → Mute Guild → for how long; its messages don't light
// its rail dot (a mention of you still counts), its channels aren't drawn as muted; the menu
// then says Unmute Guild and until when, and unmuting lights the dot again; a phone mutes from
// the sheet you get by holding the icon.
//   node e2e/serve.mjs &   then   node e2e/guildmute.mjs [screenshot dir]
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
let c;
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Hushed' });
  const general = guild.channels[0];
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);
  const say = (content) => api(alice.page, 'POST', `/channels/${general.id}/messages`, { content });

  // Bob mutes the guild from its icon on the rail, staying in his DMs.
  const b = bob.page;
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('#dm-main');
  const icon = '.rail-guild[aria-label="Hushed"]';
  await b.click(icon, { button: 'right' });
  await b.hover('.context-menu >> text=Mute Guild');
  await b.waitForSelector('.context-submenu');
  await shot(b, 'menu');
  await b.click('.context-submenu >> text=For 1 hour');
  await b.waitForSelector('.context-menu', { state: 'detached' });
  const mutes = await api(b, 'GET', '/guild-mutes');
  check(mutes.length === 1 && mutes[0].guild_id === guild.id && mutes[0].until > Date.now() / 1000 + 3500, 'muted for an hour');

  const dotLit = () => b.evaluate((sel) => document.querySelector(`.nav-item:has(${sel}) .dot`).classList.contains('visible'), icon);
  await say('nobody needs to see this');
  await pause(1500);
  check(!(await dotLit()), 'no unread dot on a muted guild');
  await say(`hey <@${bob.id}>`);
  await b.waitForSelector('.rail-mention-badge', { timeout: 10000 });
  check((await b.textContent('.rail-mention-badge')) === '1', 'a mention still counts on its icon');
  await shot(b, 'rail');

  // The menu now offers Unmute Guild, saying until when.
  await b.click(icon, { button: 'right' });
  const unmute = b.locator('.context-menu .guild-menu-item', { hasText: 'Unmute Guild' });
  await unmute.waitFor();
  const text = await unmute.textContent();
  check(/Muted until (.*, )?\d{1,2}:\d{2}/.test(text), `the menu says "${text.replace('Unmute Guild', '').trim()}"`);
  check(await b.locator('.context-menu .guild-menu-item', { hasText: /^Mute Guild/ }).count() === 0, 'and no Mute Guild');
  await shot(b, 'menu-muted');
  await b.keyboard.press('Escape');
  await b.waitForSelector('.context-menu', { state: 'detached' });

  // Inside the guild, its channels aren't drawn as muted.
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  check(!(await b.$('.guild-channel.muted')), "its channels aren't drawn as muted ones");

  // Unmuted, a new message lights the dot again.
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('#dm-main');
  await b.click(icon, { button: 'right' });
  await b.click('.context-menu >> text=Unmute Guild');
  await b.waitForSelector('.context-menu', { state: 'detached' });
  check((await api(b, 'GET', '/guild-mutes')).length === 0, 'unmuted');
  await say('now you see me');
  await b.waitForFunction((sel) => document.querySelector(`.nav-item:has(${sel}) .dot`)?.classList.contains('visible'), icon, { timeout: 10000 });
  check(true, 'unmuted, the guild lights up again');

  // Carol, on a phone, holds the icon and mutes from the sheet.
  c = carol.page;
  // A phone's /dm is the Friends pane: open a chat and go back to the list, with the rail.
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {});
  await c.waitForSelector(icon);
  await c.waitForTimeout(400);
  const cdp = await c.context().newCDPSession(c);
  const box = await c.locator(icon).boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await c.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.context-sheet');
  await c.tap('.context-sheet >> text=Mute Guild');
  await c.waitForSelector('.context-sheet >> text=Until I turn it back on');
  await shot(c, 'phone-submenu');
  await c.tap('.context-sheet >> text=Until I turn it back on');
  await c.waitForSelector('.context-sheet', { state: 'detached' });
  const carolMutes = await api(c, 'GET', '/guild-mutes');
  check(carolMutes.length === 1 && carolMutes[0].until === null, 'muted from the phone until unmuted');

  console.log('guildmute: ok');
} catch (err) {
  console.error('guildmute: FAILED', err.message.split('\n')[0]);
  if (c) await shot(c, 'failed').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
