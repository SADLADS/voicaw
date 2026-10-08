// Bot DMs in a real browser: a bot (this script, through the bot API) opens a DM with Alice
// and sends an embed; the conversation appears live in her DM list (BOT tag, unread dot), opens
// with "Not encrypted" and the notice, text only (no + menu); her reply reaches the bot; the
// row's menu mutes (no call); Settings → Content's "Let bots message me" off refuses the bot;
// Delete conversation removes it for both; a bot's member card has Message; then a phone.
//   node e2e/serve.mjs &   then   node e2e/botdms.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
};
const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;

// The app's API as the page's user.
const app = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}, [method, path, body]);

// The bot API, as a Discord library calls it.
const bot = async (token, method, path, body) => {
  const res = await fetch(`${API}/api/v10${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 760 } });
  const a = alice.page;
  const guild = await app(a, 'POST', '/guilds', { name: 'Game Night' });
  const created = await app(a, 'POST', '/applications', { name: 'Chess Bot' });
  await app(a, 'POST', '/oauth2/authorize', { client_id: String(created.id), guild_id: guild.id, permissions: String((1 << 10) | (1 << 11)) });
  const token = created.token;

  await a.goto(`${BASE}/dm`);
  await a.waitForSelector('#dm-sidebar');
  const channel = (await bot(token, 'POST', '/users/@me/channels', { recipient_id: String(alice.id) })).body;
  if (channel.type !== 1) throw new Error(`no DM channel: ${JSON.stringify(channel)}`);
  const sent = await bot(token, 'POST', `/channels/${channel.id}/messages`, {
    content: "It's your move in game 12.", embeds: [{ title: 'Chess', description: 'Day 2 reminder: 1 day left before auto-resign', color: 0x5865f2 }],
  });
  if (sent.status !== 200) throw new Error(`send failed: ${JSON.stringify(sent.body)}`);

  // Live in the list: BOT tag and the unread dot.
  const row = a.locator('.dm-bot', { hasText: 'Chess Bot' });
  await row.waitFor();
  await a.waitForSelector('.dm-bot .userdot.active');
  if (!(await row.locator('.app-tag').isVisible())) throw new Error('no BOT tag on the row');
  await shot(a, 'list-unread');
  console.log('the DM appeared live in the list, tagged BOT, unread');

  await row.click();
  await a.waitForSelector('text=Day 2 reminder: 1 day left before auto-resign');
  await a.waitForSelector('.bot-dm-plain:has-text("Not encrypted")');
  await a.waitForSelector('.bot-dm-notice');
  if (await a.$('.attach-button')) throw new Error('the + menu should be gone in a bot DM');
  await a.waitForSelector('.dm-bot .userdot:not(.active)');
  await a.click('#dm-input');
  await a.keyboard.type('On it, thanks');
  await a.keyboard.press('Enter');
  await a.waitForSelector('text=On it, thanks');
  await shot(a, 'conversation');
  const history = (await bot(token, 'GET', `/channels/${channel.id}/messages`)).body;
  if (history[0]?.content !== 'On it, thanks' || history[0].author.id !== String(alice.id)) throw new Error('the bot did not get the reply');
  console.log('opened: Not encrypted + notice, no + menu; the reply reached the bot');

  // The row's menu: mute, no call.
  await row.click({ button: 'right' });
  await a.waitForSelector('[role="menu"] >> text=Mute Conversation');
  if (await a.$('[role="menu"] >> text=Start Call')) throw new Error('a bot DM offers a call');
  await shot(a, 'menu');
  await a.keyboard.press('Escape');

  // Settings → Content: off refuses the bot; on again lets it.
  await a.goto(`${BASE}/settings#content`);
  await a.uncheck('label:has-text("Let bots message me") input');
  await a.waitForTimeout(500);
  const refused = await bot(token, 'POST', `/channels/${channel.id}/messages`, { content: 'hello?' });
  if (refused.body.code !== 50007) throw new Error(`not refused: ${JSON.stringify(refused.body)}`);
  await a.check('label:has-text("Let bots message me") input');
  await a.waitForTimeout(500);
  if ((await bot(token, 'POST', `/channels/${channel.id}/messages`, { content: 'Back again' })).status !== 200) throw new Error('not let back in');
  console.log('Settings → Content off refused the bot (50007), on let it back');

  // Delete conversation: gone for both.
  await a.goto(`${BASE}/dm/b/${Number(channel.id) - 2 ** 41}`);
  await a.waitForSelector('text=Back again');
  await a.click('button[aria-label="Delete conversation"]');
  await a.click('.vc-dialog button:has-text("Delete")');
  await a.waitForURL(/\/dm(\/\d+)?$/);
  await a.waitForSelector('.dm-bot', { state: 'detached' });
  if ((await bot(token, 'GET', `/channels/${channel.id}`)).status !== 404) throw new Error('the bot still has the deleted DM');
  console.log('Delete conversation: gone from the list and for the bot');

  // A bot's right-click menu (its member list row) has Message, which starts the DM.
  await a.goto(`${BASE}/guild/${guild.id}`);
  await a.click('.member-row:has-text("Chess Bot")', { button: 'right' });
  await a.click('.context-menu >> text=Message');
  await a.waitForURL(/\/dm\/b\/\d+/);
  await a.waitForSelector('.bot-dm-notice');
  await shot(a, 'from-member-menu');
  console.log("the bot's right-click menu's Message opened a new DM");

  // A phone: Bob joins, the bot messages him.
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  const b = bob.page;
  const invite = await app(a, 'POST', `/guilds/${guild.id}/invites`);
  await app(b, 'POST', `/invites/${invite.code}`);
  const bobChannel = (await bot(token, 'POST', '/users/@me/channels', { recipient_id: String(bob.id) })).body;
  await bot(token, 'POST', `/channels/${bobChannel.id}/messages`, { content: 'Welcome to Game Night! Type /help in #general for commands.' });
  await b.goto(`${BASE}/dm`);
  const phoneRow = b.locator('.dm-bot', { hasText: 'Chess Bot' });
  await phoneRow.waitFor({ state: 'attached' });
  // The list is under the page a phone opens with (Friends): its back arrow slides to it.
  await b.waitForSelector('.friends-body, #dm-main');
  await b.click('.pane-back-button');
  await b.waitForSelector('.main-wrapper.pane-list:not(.panes-moving)');
  await shot(b, 'phone-list');
  await phoneRow.click();
  await b.waitForSelector('text=Welcome to Game Night!');
  await b.waitForSelector('.bot-dm-notice');
  await shot(b, 'phone-conversation');
  const overflow = await b.evaluate(() => document.querySelector('#dm-main').scrollWidth - document.querySelector('#dm-main').clientWidth);
  if (overflow > 1) throw new Error(`the phone page is ${overflow}px too wide`);
  console.log('phone: opened and fits');
  console.log('botdms: ok');
} catch (err) {
  console.error('botdms: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
