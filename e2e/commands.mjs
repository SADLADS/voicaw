// Bot commands in a real browser: a tiny bot (here, over the throwaway gateway) registers a
// slash command with options (autocomplete, a number, true/false, a member), one with a
// subcommand, and a message command; then in Chrome "/" lists them, one is picked, its fields
// filled (with the bot's suggestions) and run, the bot's reply shows; the subcommand and the
// message's Apps menu too; then the same on a phone.
//   node e2e/serve.mjs &   then   node e2e/commands.mjs [screenshot dir]
import WebSocket from 'ws';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;
const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const fail = (msg) => { console.error('FAIL', msg); process.exit(1); };
const ok = (cond, msg) => { if (!cond) fail(msg); console.log('ok', msg); };

const browser = await launchChrome();
const owner = await signUp(browser, 'cmdowner');
const page = owner.page;
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: b ? JSON.stringify(b) : undefined });
  return res.json();
}, [method, path, body]);

const guild = await call('POST', '/guilds', { name: 'Command Town' });
const general = guild.channels[0];
const app = await call('POST', '/applications', { name: 'Weather Bot' });
await call('POST', '/oauth2/authorize', { client_id: app.id, guild_id: guild.id, permissions: String((1n << 10n) | (1n << 11n)) });
await call('POST', `/channels/${general.id}/messages`, { content: 'Quote me on this' });

// ---- The bot ----
const botFetch = (path, method, body) => fetch(`${API}/api/v10${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bot ${app.token}` }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const registered = await botFetch(`/applications/${app.id}/commands`, 'PUT', [
  {
    name: 'weather', description: 'The forecast for a city',
    options: [
      { type: 3, name: 'city', description: 'Which city', required: true, autocomplete: true },
      { type: 4, name: 'days', description: 'How many days', min_value: 1, max_value: 7 },
      { type: 5, name: 'metric', description: 'In Celsius' },
      { type: 6, name: 'for', description: 'Who it is for' },
    ],
  },
  { name: 'settings', description: 'Bot settings', options: [{ type: 1, name: 'units', description: 'Choose units', options: [{ type: 3, name: 'unit', description: 'Unit', required: true, choices: [{ name: 'Celsius', value: 'c' }, { name: 'Fahrenheit', value: 'f' }] }] }] },
  { type: 3, name: 'Quote' },
]);
ok(registered.length === 3, 'bot registered 3 commands');

const seen = [];
const ws = new WebSocket(`${API.replace('http', 'ws')}/api/gateway?v=10&encoding=json`);
await new Promise((resolve) => {
  ws.on('message', async (raw) => {
    const p = JSON.parse(raw.toString());
    if (p.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: app.token, intents: 1 } }));
    if (p.t === 'READY') resolve();
    if (p.t !== 'INTERACTION_CREATE') return;
    const i = p.d;
    seen.push(i);
    const respond = (body) => fetch(`${API}/api/v10/interactions/${i.id}/${i.token}/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (i.type === 4) {
      const typed = String(i.data.options.find((o) => o.focused)?.value ?? '').toLowerCase();
      await respond({ type: 8, data: { choices: ['London', 'Lisbon', 'Leeds', 'Paris'].filter((c) => c.toLowerCase().startsWith(typed)).map((c) => ({ name: c, value: c.toLowerCase() })) } });
    } else if (i.data.name === 'weather') {
      const o = Object.fromEntries(i.data.options.map((x) => [x.name, x.value]));
      await respond({ type: 4, data: { content: `Sunny in ${o.city} for ${o.days ?? 1} day(s), metric ${o.metric ?? false}${o.for ? ` for <@${o.for}>` : ''}` } });
    } else if (i.data.name === 'settings') {
      await respond({ type: 4, data: { content: `Units set to ${i.data.options[0].options[0].value}` } });
    } else if (i.data.name === 'Quote') {
      const target = i.data.resolved.messages[i.data.target_id];
      await respond({ type: 4, data: { content: `> ${target.content}` } });
    }
  });
});

// ---- Desktop ----
const lastText = () => page.locator('.dm-message-content').last().innerText();
await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await page.waitForSelector('#dm-input');
await page.click('#dm-input');
await page.keyboard.type('/');
await page.waitForSelector('.command-suggestions');
await shot(page, 'picker');
ok((await page.locator('.command-suggestion').count()) === 2, '"/" lists the two slash commands (subcommand as /settings units)');
await page.keyboard.type('wea');
ok((await page.locator('.command-suggestion').count()) === 1, 'filtered by what is typed');
await page.keyboard.press('Enter');
await page.waitForSelector('.command-composer');
const city = page.locator('#command-option-city');
await city.fill('L');
await page.waitForSelector('.command-option-choice:has-text("Lisbon")');
await shot(page, 'autocomplete');
ok(seen.some((i) => i.type === 4), 'the bot was asked for suggestions');
await page.locator('.command-option-choice', { hasText: 'Lisbon' }).dispatchEvent('mousedown');
await page.fill('#command-option-days', '3');
await page.selectOption('#command-option-metric', 'true');
await page.selectOption('#command-option-for', String(owner.id));
await shot(page, 'command-mode');
await page.click('.command-composer button[type="submit"]');
await page.waitForFunction(() => document.querySelector('.dm-message-content:last-of-type') && [...document.querySelectorAll('.dm-message-content')].some((el) => el.textContent.includes('Sunny in lisbon')));
ok((await lastText()).includes('Sunny in lisbon for 3 day(s), metric true'), "the bot's reply shows");
ok((await page.locator('.command-composer').count()) === 0, 'back to the message box');

await page.click('#dm-input');
await page.keyboard.type('/sett');
await page.waitForSelector('.command-suggestion');
await page.keyboard.press('Enter');
await page.selectOption('#command-option-unit', 'f');
await shot(page, 'subcommand');
await page.click('.command-composer button[type="submit"]');
await page.waitForFunction(() => [...document.querySelectorAll('.dm-message-content')].some((el) => el.textContent.includes('Units set to f')));
ok(true, 'subcommand with choices ran');

// The message's Apps menu.
await page.locator('.dm-message-content', { hasText: 'Quote me on this' }).click({ button: 'right' });
await page.getByRole('menuitem', { name: /Apps/ }).click();
await shot(page, 'apps-menu');
await page.getByRole('menuitem', { name: /Quote/ }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.dm-message-content')].some((el) => el.textContent.trim() === 'Quote me on this' && el.closest('blockquote, .dm-message-content')) && [...document.querySelectorAll('blockquote')].some((b) => b.textContent.includes('Quote me on this')));
ok(true, 'message command from the Apps menu ran');
await shot(page, 'desktop-after');

// ---- Phone ----
const phone = await browser.newContext(devices['Pixel 7']);
const p2 = await phone.newPage();
await p2.goto(`${BASE}/`);
await p2.evaluate((token) => localStorage.setItem('token', token), await page.evaluate(() => localStorage.getItem('token')));
await p2.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await p2.waitForSelector('#dm-input', { timeout: 20000 });
await p2.click('#dm-input');
await p2.keyboard.type('/');
await p2.waitForSelector('.command-suggestions');
await p2.screenshot({ path: shots ? `${shots}/phone-picker.png` : '/dev/null' });
await p2.locator('.command-suggestion', { hasText: '/weather' }).tap();
await p2.waitForSelector('.command-composer');
await p2.locator('#command-option-city').fill('Pa');
await p2.waitForSelector('.command-option-choice:has-text("Paris")');
await p2.screenshot({ path: shots ? `${shots}/phone-command-mode.png` : '/dev/null' });
await p2.locator('.command-option-choice', { hasText: 'Paris' }).dispatchEvent('mousedown');
await p2.locator('.command-composer button[type="submit"]').tap();
await p2.waitForFunction(() => [...document.querySelectorAll('.dm-message-content')].some((el) => el.textContent.includes('Sunny in paris')));
ok(true, 'ran from a phone');
await p2.screenshot({ path: shots ? `${shots}/phone-after.png` : '/dev/null' });

ws.close(1000);
await browser.close();
console.log('all good');
