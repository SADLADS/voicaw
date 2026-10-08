// Bots' buttons, select menus and forms in a real browser: a tiny bot (over the throwaway
// gateway) posts a message with buttons in every style (link, emoji, disabled), a string select
// and a user select; in Chrome a button updates the message, a choice gets an ephemeral reply
// ("Only you can see this", Dismiss), a button opens the bot's form (filled in and sent), another
// defers ("thinking…") and fills in later, and a slash command's answer says who used it; light
// and dark, then a phone (the select's list as a sheet).
//   node e2e/serve.mjs &   then   node e2e/components.mjs [screenshot dir]
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
const owner = await signUp(browser, 'compowner', { viewport: { width: 1100, height: 800 } });
const page = owner.page;
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: b ? JSON.stringify(b) : undefined });
  return res.json();
}, [method, path, body]);

const guild = await call('POST', '/guilds', { name: 'Button Town' });
const general = guild.channels[0];
const app = await call('POST', '/applications', { name: 'Helper' });
await call('POST', '/oauth2/authorize', { client_id: app.id, guild_id: guild.id, permissions: String((1n << 10n) | (1n << 11n)) });

// ---- The bot ----
const bot = (path, method, body) => fetch(`${API}/api/v10${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bot ${app.token}` }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const [menuCommand] = await bot(`/applications/${app.id}/commands`, 'PUT', [{ name: 'menu', description: 'Shows the menu' }]);

const components = (count = 0) => [
  { type: 1, components: [
    { type: 2, style: 1, label: `Count (${count})`, custom_id: 'count' },
    { type: 2, style: 2, label: 'Feedback', custom_id: 'form' },
    { type: 2, style: 3, label: 'Slow', custom_id: 'slow', emoji: { name: '🐢' } },
    { type: 2, style: 4, label: 'Danger', custom_id: 'danger', disabled: true },
    { type: 2, style: 5, label: 'Docs', url: 'https://voicaw.com/developers/docs/' },
  ] },
  { type: 1, components: [{ type: 3, custom_id: 'fruit', placeholder: 'Pick a fruit', options: [
    { label: 'Apple', value: 'apple', description: 'Crunchy', emoji: { name: '🍎' } },
    { label: 'Pear', value: 'pear', description: 'Juicy', emoji: { name: '🍐' } },
  ] }] },
  { type: 1, components: [{ type: 5, custom_id: 'who', placeholder: 'Pick someone' }] },
];

let count = 0;
const ws = new WebSocket(`${API.replace('http', 'ws')}/api/gateway?v=10&encoding=json`);
await new Promise((resolve) => {
  ws.on('message', async (raw) => {
    const p = JSON.parse(raw.toString());
    if (p.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: app.token, intents: 1 } }));
    if (p.t === 'READY') resolve();
    if (p.t !== 'INTERACTION_CREATE') return;
    const i = p.d;
    const respond = (body) => fetch(`${API}/api/v10/interactions/${i.id}/${i.token}/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (i.type === 2) return respond({ type: 4, data: { content: 'Here is the menu', components: components(count) } });
    if (i.type === 5) return respond({ type: 4, data: { content: `Thanks for "${i.data.components[0].components[0].value}"` } });
    const id = i.data.custom_id;
    if (id === 'count') return respond({ type: 7, data: { content: `Counted ${++count}`, components: components(count) } });
    if (id === 'fruit') return respond({ type: 4, data: { content: `You picked ${i.data.values[0]}`, flags: 64 } });
    if (id === 'who') return respond({ type: 4, data: { content: `Hello <@${i.data.values[0]}>`, flags: 64 } });
    if (id === 'form') {
      return respond({ type: 9, data: { custom_id: 'fb', title: 'Feedback', components: [
        { type: 1, components: [{ type: 4, custom_id: 'text', label: 'What do you think?', style: 2, min_length: 3, placeholder: 'Be nice' }] },
      ] } });
    }
    if (id === 'slow') {
      await respond({ type: 5 });
      setTimeout(() => fetch(`${API}/api/v10/webhooks/${app.id}/${i.token}/messages/@original`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Done thinking 🐢' }),
      }), 1500);
    }
    return null;
  });
});

await bot(`/channels/${general.id}/messages`, 'POST', { content: 'Choose something', components: components() });

// ---- Desktop ----
const message = () => page.locator('.each-dm-message-wrapper').filter({ hasText: 'Choose something' }).or(page.locator('.each-dm-message-wrapper').filter({ hasText: 'Counted' })).first();
await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await page.waitForSelector('.bot-components');
ok(await page.locator('.bot-button.primary').count() === 1 && await page.locator('.bot-button.danger[disabled]').count() === 1, 'buttons in their styles, the disabled one disabled');
ok(await page.getAttribute('a.bot-button.link', 'rel') === 'noopener noreferrer', 'the link button opens without a referrer');
await shot(page, 'components-dark');

await page.click('button:has-text("Count (0)")');
await page.waitForSelector('text=Counted 1');
ok(await page.locator('button:has-text("Count (1)")').count() === 1, 'a click updated the message (type 7)');

await page.click('button.bot-select-field:has-text("Pick a fruit")');
await page.waitForSelector('.bot-select-menu');
await shot(page, 'select-open');
await page.click('.bot-select-option:has-text("Pear")');
await page.waitForSelector('text=You picked pear');
ok(await page.locator('.each-dm-message-wrapper.ephemeral').count() === 1, 'the choice got an ephemeral reply');
ok(await page.locator('text=Only you can see this').count() === 1, 'it says only you can see it');
await shot(page, 'ephemeral');
await page.click('button:has-text("Dismiss message")');
await page.waitForFunction(() => !document.querySelector('.each-dm-message-wrapper.ephemeral'));
console.log('ok Dismiss removed it');

await page.click('button.bot-select-field:has-text("Pick someone")');
await page.click(`.bot-select-option:has-text("${owner.name}")`);
await page.waitForSelector('.each-dm-message-wrapper.ephemeral');
console.log('ok a user select works');
await page.click('button:has-text("Dismiss message")');

await page.click('button:has-text("Feedback")');
await page.waitForSelector('.vc-dialog.bot-modal');
await shot(page, 'modal');
await page.click('.vc-dialog button:has-text("Submit")');
ok(await page.locator('.vc-dialog .error-msg').count() === 1, 'the form checks its fields first');
await page.fill('.vc-dialog textarea', 'Great buttons');
await page.click('.vc-dialog button:has-text("Submit")');
await page.waitForSelector('text=Thanks for "Great buttons"');
ok(await page.locator('.vc-dialog.bot-modal').count() === 0, 'the form was sent and closed');

await page.click('button:has-text("Slow")');
await page.waitForSelector('.interaction-thinking');
await shot(page, 'thinking');
await page.waitForSelector('text=Done thinking');
ok(await page.locator('.interaction-thinking').count() === 0, 'the deferred reply was filled in');

await call('POST', `/channels/${general.id}/command-interactions`, { command_id: menuCommand.id });
await page.waitForSelector('.interaction-header');
ok((await page.locator('.interaction-header').last().innerText()).includes('used /menu'), 'the answer says who used /menu');
await page.locator('.interaction-header').last().scrollIntoViewIfNeeded();
await shot(page, 'command-reply-dark');

// Light.
await page.goto(`${BASE}/settings#appearance`);
await page.waitForSelector('#settings-theme');
await page.click('#settings-theme >> text=Light');
await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await page.waitForSelector('.bot-components');
await page.waitForTimeout(500);
await shot(page, 'components-light');
await page.locator('button.bot-select-field:has-text("Pick a fruit")').last().click();
await shot(page, 'select-open-light');
void message;

// ---- Phone ----
const phone = await browser.newContext(devices['Pixel 7']);
const p2 = await phone.newPage();
await p2.goto(`${BASE}/`);
await p2.evaluate((token) => localStorage.setItem('token', token), await page.evaluate(() => localStorage.getItem('token')));
await p2.goto(`${BASE}/guild/${guild.id}/${general.id}`);
await p2.waitForSelector('.bot-components', { timeout: 20000 });
await p2.waitForTimeout(800);
await shot(p2, 'phone-components');
await p2.locator('button.bot-select-field:has-text("Pick a fruit")').last().tap();
await p2.waitForSelector('.bot-select-menu');
const sheet = await p2.locator('.bot-select-menu').boundingBox();
const viewport = p2.viewportSize();
ok(Math.abs(sheet.y + sheet.height - viewport.height) < 2 && sheet.width >= viewport.width - 1, 'on a phone the list is a sheet at the bottom');
await shot(p2, 'phone-select');
await p2.locator('.bot-select-option:has-text("Apple")').tap();
await p2.waitForSelector('text=You picked apple');
await shot(p2, 'phone-ephemeral');

ws.close();
await browser.close();
console.log('all good');
