// Mentions: "@" suggestions in a guild channel (keyboard) and a DM (phone, tap), how a mention
// shows for the person mentioned and for others, and editing a message that has one.
//   node e2e/serve.mjs &   then   node e2e/mentions.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, BASE, devices } from './helpers.mjs';

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

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Mentions' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(alice.page, 'POST', `/guilds/${guildId}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);

  for (const u of [alice, bob, carol]) {
    await u.page.goto(`${BASE}/guild/${guildId}`);
    await u.page.waitForSelector('#dm-input');
  }

  // Alice: "@" lists members; typing narrows it; Enter picks.
  const a = alice.page;
  await a.click('#dm-input');
  await a.keyboard.type('hi @');
  await a.waitForSelector('.mention-suggestions');
  const everyone = await a.$$eval('.mention-suggestions .mention-suggestion-user', (els) => els.map((e) => e.textContent));
  check(everyone.length === 3, `"@" lists all three members (${everyone.join(', ')})`);
  const mass = await a.$$eval('.mention-suggestions .mention-suggestion-everyone', (els) => els.length);
  check(mass === 2, 'and @everyone and @here, for the owner');
  await a.keyboard.type(bob.name.slice(0, 3));
  const narrowed = await a.$$eval('.mention-suggestions [role=option]', (els) => els.map((e) => e.textContent));
  check(narrowed.length === 1 && narrowed[0] === bob.name, `"@bob" narrows to bob (${narrowed.join(', ')})`);
  await shot(a, 'suggestions');
  await a.keyboard.press('Enter');
  check(!(await a.$('.mention-suggestions')), 'picking closes the list');
  check((await a.textContent('#dm-input .mention')) === `@${bob.name}`, 'the box shows @bob as a chip');
  await shot(a, 'chip');
  await a.keyboard.type('look at this');
  await a.keyboard.press('Enter');

  // Escape dismisses the list.
  await a.keyboard.type('@');
  await a.waitForSelector('.mention-suggestions');
  await a.keyboard.press('Escape');
  check(!(await a.$('.mention-suggestions')), 'Escape closes the list');
  await a.keyboard.press('Backspace');

  // Bob sees it as a mention of him; Carol as a plain mention.
  const mine = await bob.page.waitForSelector('.dm-message-content .mention', { timeout: 10000 });
  check((await mine.textContent()) === `@${bob.name}`, 'bob sees @bob');
  check(await mine.evaluate((el) => el.classList.contains('mention-me')), "it's marked as him");
  check(await mine.evaluate((el) => el.closest('.each-dm-message-wrapper').classList.contains('mentioned')), 'his message is highlighted');
  await bob.page.mouse.move(5, 5);
  await shot(bob.page, 'mentioned');
  const theirs = await carol.page.waitForSelector('.dm-message-content .mention', { timeout: 10000 });
  check(!(await theirs.evaluate((el) => el.classList.contains('mention-me'))), 'carol sees a mention of someone else');
  check(!(await theirs.evaluate((el) => el.closest('.each-dm-message-wrapper').classList.contains('mentioned'))), 'not highlighted for carol');

  // Editing keeps the mention as a chip, and saving keeps it.
  await a.hover('.each-dm-message-wrapper.sent');
  await a.click('.each-dm-message-wrapper.sent .message-menu button:has([data-icon="pen-to-square"]), .each-dm-message-wrapper.sent .message-menu button:nth-child(2)');
  await a.waitForSelector('.inline-edit-editor .mention');
  check((await a.textContent('.inline-edit-editor .mention')) === `@${bob.name}`, 'editing shows the mention as a chip');
  await a.keyboard.type('!');
  await a.keyboard.press('Enter');
  await bob.page.waitForSelector('text=look at this!', { timeout: 10000 });
  check(Boolean(await bob.page.$('.mentioned .mention-me')), 'the edited message still mentions bob');

  // Carol elsewhere: a mention of her shows as a red count on the server and the channel.
  const c = carol.page;
  await c.click('a[aria-label="Direct Messages"]');
  await c.waitForSelector('#dm-main');
  await a.click('#dm-input');
  await a.keyboard.type(`@${carol.name.slice(0, 4)}`);
  await a.keyboard.press('Enter');
  await a.keyboard.type('ping');
  await a.keyboard.press('Enter');
  const badge = await c.waitForSelector('.rail-mention-badge', { timeout: 10000 });
  check((await badge.textContent()) === '1', 'the server icon shows 1 mention');
  await shot(c, 'rail-badge');
  await c.click(`a[aria-label="Mentions"]`);
  await c.waitForSelector('#dm-input');
  await c.waitForFunction(() => !document.querySelector('.rail-mention-badge'), null, { timeout: 10000 });
  check(true, 'opening the channel clears it');

  // @everyone (the owner may), and roles.
  await a.keyboard.type('@every');
  const everyoneOpt = await a.waitForSelector('.mention-suggestions [role=option]:has-text("@everyone")');
  check(Boolean(everyoneOpt), 'the owner is offered @everyone');
  await a.keyboard.press('Enter');
  await a.keyboard.type('meeting now');
  await a.keyboard.press('Enter');
  await bob.page.waitForSelector('.mentioned:has-text("meeting now") .mention:has-text("@everyone")', { timeout: 10000 });
  check(true, 'bob sees @everyone highlighted');

  const role = await api(a, 'POST', `/guilds/${guildId}/roles`, { name: 'Raiders', color: 0x2ecc71, mentionable: true });
  await api(a, 'PUT', `/guilds/${guildId}/members/${carol.id}/roles`, { roleIds: [role.id] });
  const b = bob.page;
  await b.click('#dm-input');
  await b.keyboard.type('@Rai');
  await b.waitForSelector('.mention-suggestions [role=option]:has-text("Raiders")');
  check(!(await b.$('.mention-suggestions [role=option]:has-text("@everyone")')), 'bob (no Mention Everyone) gets the mentionable role but not @everyone');
  await shot(b, 'role-suggestion');
  await b.keyboard.press('Enter');
  await b.keyboard.type('assemble');
  await b.keyboard.press('Enter');
  const roleMention = await c.waitForSelector('.mentioned .role-mention', { timeout: 10000 });
  check((await roleMention.textContent()) === '@Raiders', 'carol sees @Raiders on a message for her');
  await c.mouse.move(5, 5);
  await shot(c, 'role-mentioned');

  // A private channel: only the people who can see it are listed and suggested.
  const secret = await api(a, 'POST', `/guilds/${guildId}/channels`, { name: 'secret', type: 'text' });
  const everyoneRole = guild.roles.find((r) => r.is_everyone);
  await api(a, 'PUT', `/guilds/${guildId}/channels/${secret.id}/overrides/role/${everyoneRole.id}`, { allow: 0, deny: 1 });
  await api(a, 'PUT', `/guilds/${guildId}/channels/${secret.id}/overrides/member/${bob.id}`, { allow: 1, deny: 0 });
  await a.goto(`${BASE}/guild/${guildId}/${secret.id}`);
  await a.waitForSelector('#dm-input');
  await a.waitForFunction((name) => !document.querySelector('.guild-body')?.textContent.includes(name), carol.name, { timeout: 10000 });
  check(true, "carol isn't in #secret's member list");
  await a.click('#dm-input');
  await a.keyboard.type('@');
  await a.waitForSelector('.mention-suggestions');
  const inSecret = await a.$$eval('.mention-suggestions [role=option]', (els) => els.map((e) => e.textContent));
  check(!inSecret.some((t) => t.includes(carol.name)) && inSecret.includes(bob.name), `#secret suggests bob, not carol (${inSecret.join(', ')})`);
  await shot(a, 'private-suggestions');
  await a.keyboard.press('Escape');
  await a.keyboard.press('Backspace');

  // Notification settings.
  await c.click('.guild-header-button');
  await c.click('text=Notification Settings');
  await c.check('input[value="all"]');
  await shot(c, 'notifications');
  await c.waitForFunction(async (id) => {
    const res = await fetch(`/api/guilds/${id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).my_notify_level === 'all';
  }, guildId, { timeout: 10000 });
  check(true, 'choosing "All messages" is saved');
  await c.click('button:has-text("Done")');

  // Phone, in a DM: tap a suggestion.
  const dave = await signUp(browser, 'dave', { ...devices['Pixel 7'] });
  const p = dave.page;
  await openChat(p, alice.id);
  await p.tap('#dm-input');
  await p.keyboard.type('@');
  await p.waitForSelector('.mention-suggestions');
  await shot(p, 'phone-suggestions');
  await p.tap(`.mention-suggestions [role=option]:has-text("${alice.name}")`);
  check((await p.textContent('#dm-input .mention')) === `@${alice.name}`, 'tapping a suggestion on a phone inserts it');
  await p.tap('.send-button');
  await p.waitForSelector('.dm-message-content .mention');
  await shot(p, 'phone-sent');
  console.log('mentions: ok');
} catch (err) {
  console.error('mentions: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
