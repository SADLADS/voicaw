// The "/" list with many commands: two bots (24 and 3 commands) in one guild; "/" lists every
// one (no cap), in a section per bot under its name, and the list scrolls inside its height;
// arrow keys go down the list as drawn and keep the highlighted one in view (Up from the top
// wraps to the last); typing narrows it to the matching bots' sections; then a phone.
//   node e2e/serve.mjs &   then   node e2e/commandsections.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;
const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const fail = (msg) => { console.error('FAIL', msg); process.exit(1); };
const ok = (cond, msg) => { if (!cond) fail(msg); console.log('ok', msg); };

const browser = await launchChrome();
const owner = await signUp(browser, 'cmdsections');
const page = owner.page;
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: b ? JSON.stringify(b) : undefined });
  return res.json();
}, [method, path, body]);

const guild = await call('POST', '/guilds', { name: 'Many Commands' });
const general = guild.channels[0];
async function addBot(name, commands) {
  const app = await call('POST', '/applications', { name });
  await call('POST', '/oauth2/authorize', { client_id: app.id, guild_id: guild.id, permissions: String(1n << 11n) });
  const registered = await fetch(`${API}/api/v10/applications/${app.id}/commands`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bot ${app.token}` }, body: JSON.stringify(commands),
  }).then((r) => r.json());
  ok(registered.length === commands.length, `${name} registered ${commands.length} commands`);
}
await addBot('Music Bot', Array.from({ length: 24 }, (_, i) => ({ name: `music${String(i).padStart(2, '0')}`, description: `Music command ${i}` })));
await addBot('Dice Bot', [
  { name: 'roll', description: 'Roll some dice' },
  { name: 'flip', description: 'Flip a coin' },
  { name: 'musicquiz', description: 'Guess the song' },
]);

const listState = (p) => p.evaluate(() => {
  const list = document.querySelector('.command-suggestions');
  const active = list.querySelector('[aria-selected="true"]');
  const l = list.getBoundingClientRect();
  const a = active?.getBoundingClientRect();
  const header = active?.closest('.command-suggestion-section')?.querySelector('.command-suggestion-bot').getBoundingClientRect();
  return {
    count: list.querySelectorAll('.command-suggestion').length,
    sections: [...list.querySelectorAll('.command-suggestion-section')].map((s) => [s.querySelector('.command-suggestion-bot').textContent, s.querySelectorAll('.command-suggestion').length]),
    scrolls: list.scrollHeight > list.clientHeight + 4,
    height: l.height,
    active: active?.querySelector('.command-suggestion-name').textContent,
    // Fully visible, and not under its section's sticky header.
    activeVisible: a ? a.top >= Math.max(l.top, header.bottom) - 1 && a.bottom <= l.bottom + 1 : false,
    pageScroll: document.scrollingElement.scrollTop,
  };
});

async function check(p, label) {
  await p.click('#dm-input');
  await p.keyboard.type('/');
  await p.waitForFunction(() => document.querySelectorAll('.command-suggestion').length === 27);
  let s = await listState(p);
  ok(s.count === 27, `${label}: "/" lists all 27 commands`);
  ok(JSON.stringify(s.sections) === JSON.stringify([['Music Bot', 24], ['Dice Bot', 3]]) || JSON.stringify(s.sections) === JSON.stringify([['Dice Bot', 3], ['Music Bot', 24]]), `${label}: one section per bot (${JSON.stringify(s.sections)})`);
  ok(s.scrolls, `${label}: the list scrolls (${Math.round(s.height)} px high)`);
  await shot(p, `${label}-picker`);

  // Up from the first wraps to the last, which comes into view.
  await p.keyboard.press('ArrowUp');
  s = await listState(p);
  ok(s.activeVisible, `${label}: ArrowUp wraps to the last (${s.active}), scrolled into view`);
  ok(s.pageScroll === 0, `${label}: the page itself didn't scroll`);
  await shot(p, `${label}-last`);
  await p.keyboard.press('ArrowDown');
  s = await listState(p);
  ok(s.activeVisible, `${label}: ArrowDown back to the first (${s.active}), in view below its header`);
  for (let i = 0; i < 12; i++) await p.keyboard.press('ArrowDown');
  s = await listState(p);
  ok(s.activeVisible, `${label}: 12 down (${s.active}) still in view`);

  // Enter picks what's highlighted (the order as drawn).
  const expected = s.active;
  await p.keyboard.press('Enter');
  await p.waitForSelector('.command-composer');
  const picked = await p.locator('.command-composer-name').innerText();
  ok(picked.includes(expected), `${label}: Enter picked the highlighted ${expected}`);
  await p.locator('.command-composer-close').click();

  // Typing narrows it: "/music" matches both bots, Music Bot's first (its are prefix matches).
  await p.click('#dm-input');
  await p.keyboard.type('/music');
  await p.waitForFunction(() => document.querySelectorAll('.command-suggestion').length === 25);
  s = await listState(p);
  ok(JSON.stringify(s.sections) === JSON.stringify([['Music Bot', 24], ['Dice Bot', 1]]), `${label}: "/music" is sections Music Bot then Dice Bot (${JSON.stringify(s.sections)})`);
  await p.keyboard.type('quiz');
  await p.waitForFunction(() => document.querySelectorAll('.command-suggestion').length === 1);
  s = await listState(p);
  ok(JSON.stringify(s.sections) === JSON.stringify([['Dice Bot', 1]]), `${label}: "/musicquiz" leaves only Dice Bot`);
  await shot(p, `${label}-narrowed`);
  await p.keyboard.press('Escape');
}

await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await page.waitForSelector('#dm-input');
await check(page, 'desktop');

const phone = await browser.newContext(devices['Pixel 7']);
const p2 = await phone.newPage();
await p2.goto(`${BASE}/`);
await p2.evaluate((token) => localStorage.setItem('token', token), await page.evaluate(() => localStorage.getItem('token')));
await p2.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await p2.waitForSelector('#dm-input', { timeout: 20000 });
await check(p2, 'phone');

await browser.close();
console.log('all good');
