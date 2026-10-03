// Bots in a real browser: Settings → Developer Portal, a new application (its token shown once,
// then reset), permissions ticked into an invite link, the link opened and the bot authorised
// into a guild; then the same pages on a phone.
//   node e2e/serve.mjs &   then   node e2e/bots.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
};

// A guild made through the API (the rail's dialog is checked elsewhere).
const makeGuild = (page, name) => page.evaluate(async (guildName) => {
  const res = await fetch('/api/guilds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify({ name: guildName }),
  });
  return (await res.json()).id;
}, name);

const tokenOn = (page) => page.inputValue('#dev-bot-token');

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const a = alice.page;
  const guildId = await makeGuild(a, 'Bot Home');

  // Settings → Developer Portal → its own page.
  await a.goto(`${BASE}/settings#developer-portal`);
  await a.click('button:has-text("Open the Developer Portal")');
  await a.waitForURL(`${BASE}/developers`);
  await a.waitForSelector('text=You haven\'t made any applications yet.');
  if (await a.$('.guild-rail, .sidebar-wrapper')) throw new Error('the portal should be a page of its own');
  await shot(a, 'portal-empty');

  await a.click('button:has-text("New Application")');
  await a.fill('#dev-new-app-name', 'Weather Bot');
  await shot(a, 'portal-new');
  await a.click('.vc-dialog button:has-text("Create")');
  await a.waitForSelector('#dev-bot-token');
  const first = await tokenOn(a);
  if (first.split('.').length !== 3) throw new Error(`odd token ${first}`);
  await shot(a, 'portal-token');
  console.log('made an application; token shown once');

  // Reset Token: a new one, after asking.
  await a.click('button:has-text("Reset Token")');
  await a.click('.vc-dialog button:has-text("Reset Token")');
  await a.waitForFunction((old) => document.querySelector('#dev-bot-token')?.value !== old, first);
  const second = await tokenOn(a);
  // The old token no longer works, the new one does.
  const status = (token) => a.evaluate(async (t) => (await fetch('/api/v10/users/@me', { headers: { Authorization: `Bot ${t}` } })).status, token);
  if (await status(first) !== 401 || await status(second) !== 200) throw new Error('token reset did not take');
  console.log('reset the token: old one refused, new one works');

  // General: a description.
  await a.click('[role="tab"]:has-text("General Information")');
  await a.fill('#dev-app-description', 'Tells you the weather.');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('text=Saved');
  await shot(a, 'portal-general');

  // Installation: tick Kick Members, copy the link.
  await a.click('[role="tab"]:has-text("Installation")');
  await a.check('label:has-text("Kick Members") input');
  await shot(a, 'portal-installation');
  await a.click('#dev-invite-link ~ button');
  await a.waitForSelector('#dev-invite-link ~ button:has-text("Copied")');
  const link = await a.evaluate(() => navigator.clipboard.readText());
  const url = new URL(link);
  if (url.pathname !== '/oauth2/authorize' || url.searchParams.get('scope') !== 'bot') throw new Error(`odd invite link ${link}`);
  if (!(BigInt(url.searchParams.get('permissions')) & (1n << 1n))) throw new Error('Kick Members missing from the link');
  console.log('invite link:', link);

  // The link: pick the guild, untick one, authorise.
  await a.goto(link);
  await a.waitForSelector('text=Made by');
  await a.selectOption('#dev-authorize-guild', String(guildId));
  await a.uncheck('label:has-text("Add Reactions") input');
  await shot(a, 'authorize');
  await a.click('button:has-text("Authorise")');
  await a.waitForSelector('text=has been added to Bot Home');
  await shot(a, 'authorize-done');
  await a.click('button:has-text("Open Bot Home")');
  await a.waitForURL(new RegExp(`/guild/${guildId}`));
  const role = await a.evaluate(async (id) => {
    const res = await fetch(`/api/guilds/${id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).roles.find((r) => r.bot_id);
  }, guildId);
  if (!role) throw new Error('no bot role in the guild');
  console.log('authorised into the guild; its role:', role.name, role.permissions);

  // Back in the portal, the guild is listed.
  await a.goto(`${BASE}/developers`);
  await a.click('button[aria-label="Open Weather Bot"]');
  await a.click('[role="tab"]:has-text("Installation")');
  await a.waitForSelector('.dev-guild-name:has-text("Bot Home")');
  await shot(a, 'portal-guilds');

  // A phone: the portal and the same link (public bot), into its own guild.
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  const b = bob.page;
  await makeGuild(b, 'Phone Guild');
  await b.goto(`${BASE}/developers`);
  await b.waitForSelector('text=Applications');
  await shot(b, 'phone-portal');
  await b.click('button:has-text("New Application")');
  await b.fill('#dev-new-app-name', 'Pocket Bot With A Rather Long Name');
  await b.click('.vc-dialog button:has-text("Create")');
  await b.waitForSelector('#dev-bot-token');
  await shot(b, 'phone-token');
  await b.click('[role="tab"]:has-text("Installation")');
  await shot(b, 'phone-installation');
  await b.goto(link);
  await b.waitForSelector('text=Made by');
  await b.selectOption('#dev-authorize-guild', { label: 'Phone Guild' });
  await shot(b, 'phone-authorize');
  await b.click('button:has-text("Authorise")');
  await b.waitForSelector('text=has been added to Phone Guild');
  // Nothing wider than the screen.
  const overflow = await b.evaluate(() => document.querySelector('.dev-page').scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`the phone page is ${overflow}px too wide`);
  console.log('phone: portal and authorise page work');
  console.log('bots: ok');
} catch (err) {
  console.error('bots: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
