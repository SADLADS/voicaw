// Deleting an account in real browsers: Ann owns a guild, is in Bea's guild, a group DM and a
// DM with Bea. Settings → Delete account lists her guild and won't go ahead until deleting it
// is ticked; then she's logged out and can't log in again. Bea, watching, sees "Deleted User"
// in the DM (still readable, no composer), Ann's guild gone, Ann out of her guild and the
// group. Also the section on a phone.
//   node e2e/serve.mjs &   then   node e2e/account.mjs [screenshot dir]
import { launchChrome, signUp, devices, openChat, send, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// The API, as `page`'s user.
const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, path, body]);

async function guildWith(owner, member, name) {
  const guild = (await call(owner, 'POST', '/guilds', { name })).body;
  const invite = (await call(owner, 'POST', `/guilds/${guild.id}/invites`)).body;
  if ((await call(member, 'POST', `/invites/${invite.code}`)).status !== 201) throw new Error('join failed');
  return guild;
}

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  const cal = await signUp(browser, 'cal');
  // Groups are made from friends.
  await makeFriends(ann, bea, cal);
  const [a, b] = [ann.page, bea.page];

  await openChat(a, bea.id);
  await send(a, 'hi bea, bye soon');
  await a.waitForSelector('.dm-message-content:has-text("hi bea, bye soon")');

  // A group with Bea and Cal.
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('.message-system:has-text("You created the group.")');

  const annsGuild = await guildWith(a, b, 'Anns Place');
  const beasGuild = await guildWith(b, a, 'Beas Place');
  console.log('set up: a DM, a group, a guild Ann owns and one she is in');

  await openChat(b, ann.id);
  await b.waitForSelector('.dm-message-content:has-text("hi bea, bye soon")');

  // Ann deletes her account.
  await a.goto(`${BASE}/settings#delete-account`);
  await a.reload(); // the guild list is loaded at start
  await a.click('#delete-account button:has-text("Delete account")');
  await a.waitForSelector('[aria-label="Guilds you own"]:has-text("You own a guild")');
  await a.waitForSelector('[aria-label="Guilds you own"] a:has-text("Anns Place")');
  await a.fill('#delete-account input[type="password"]', ann.password);
  if (!(await a.isDisabled('button:has-text("Delete my account")'))) throw new Error('could delete without dealing with the guild');
  await shot(a, '01-owned-guild');
  await a.check('#delete-account input[type="checkbox"]');
  await a.locator('#delete-account').scrollIntoViewIfNeeded();
  await shot(a, '02-ready');
  await a.click('button:has-text("Delete my account")');
  await a.waitForSelector('input[placeholder="New Username"]', { timeout: 30000 });
  if (await a.evaluate(() => localStorage.getItem('token'))) throw new Error('still has a token');
  console.log('ann deleted her account and is back at the login page');

  // Bea's open DM turns into "Deleted User", still readable, no composer.
  await b.waitForSelector('.chat-recipient-header:has-text("Deleted User")', { timeout: 10000 });
  await b.waitForSelector('.composer-locked:has-text("This account has been deleted")');
  await b.waitForSelector('.dm-message-content:has-text("hi bea, bye soon")');
  if (await b.$('.chat-call-button[aria-label^="Call"]')) throw new Error('can still call a deleted account');
  await shot(b, '03-bea-dm');
  console.log('bea: "Deleted User", history readable, composer replaced');

  const guilds = (await call(b, 'GET', '/guilds')).body.map((g) => g.id);
  if (guilds.includes(annsGuild.id)) throw new Error("Ann's guild still exists");
  const members = (await call(b, 'GET', `/guilds/${beasGuild.id}/members`)).body.map((m) => m.id);
  if (members.includes(ann.id)) throw new Error("Ann is still in Bea's guild");
  console.log("bea: Ann's guild is gone, and Ann left Bea's guild");

  await b.goto(`${BASE}/dm`);
  await b.click('.dm-group:has-text("Trip")');
  await b.waitForSelector('.message-system:has-text("left")', { timeout: 20000 });
  await shot(b, '04-bea-group');
  console.log('bea: the group shows Ann leaving');

  // The old login no longer works.
  await a.fill('input[placeholder="Username"]', ann.name);
  await a.fill('form:has(button:text-is("Login")) input[type="password"]', ann.password);
  await a.click('button:text-is("Login")');
  await a.waitForSelector('.login-error', { timeout: 15000 });
  if (await a.$('#dm-main')) throw new Error('logged in to a deleted account');
  console.log("ann can't log in again");

  // The section on a phone.
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  await guildWith(dan.page, b, 'Dans Place');
  await dan.page.goto(`${BASE}/settings#delete-account`);
  await dan.page.click('#delete-account button:has-text("Delete account")');
  await dan.page.waitForSelector('[aria-label="Guilds you own"]');
  await dan.page.locator('#delete-account').scrollIntoViewIfNeeded();
  await shot(dan.page, '05-phone');
  const overflow = await dan.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('the page scrolls sideways on a phone');
  console.log('phone: the section fits');

  console.log('account: ok');
} catch (err) {
  console.error('account: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
