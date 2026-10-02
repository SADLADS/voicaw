// Channel mentions: "#" suggestions in a guild channel, the `#channel` link (clicking opens
// it), a private channel showing as #unknown-channel to someone who can't see it, editing
// keeping the chip, a mention in a DM (guilds not opened yet), a pasted channel link (#name for
// those who can see it, else the link), and a phone tap.
//   node e2e/serve.mjs &   then   node e2e/channel-mentions.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

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
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const VIEW_CHANNEL = 1;

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Channels' });
  const general = guild.channels[0];
  const offTopic = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'off-topic', type: 'text' });
  const secret = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'secret', type: 'text' });
  const everyone = guild.roles.find((r) => r.is_everyone);
  await api(alice.page, 'PUT', `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: VIEW_CHANNEL });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);

  const a = alice.page;
  const b = bob.page;
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await b.waitForSelector('#dm-input');

  // Alice: "#" lists the channels she can see; typing narrows; Enter picks.
  await a.click('#dm-input');
  await a.keyboard.type('see #');
  await a.waitForSelector('.mention-suggestions[aria-label="Channels"]');
  const all = await a.$$eval('.mention-suggestions .mention-suggestion-channel', (els) => els.map((e) => e.textContent));
  check(all.length === 3 && all.some((t) => t.includes('secret')), `"#" lists general, off-topic and secret (${all.join(', ')})`);
  await a.keyboard.type('off');
  const narrowed = await a.$$eval('.mention-suggestions [role=option]', (els) => els.map((e) => e.textContent));
  check(narrowed.length === 1 && narrowed[0].startsWith('off-topic'), `"#off" narrows to off-topic (${narrowed.join(', ')})`);
  await shot(a, 'suggestions');
  await a.keyboard.press('Enter');
  check((await a.textContent('#dm-input .channel-mention')) === '#off-topic', 'the box shows #off-topic as a chip');
  await a.keyboard.type('and #sec');
  await a.keyboard.press('Tab');
  await a.keyboard.press('Enter');

  // A heading-like "# " doesn't keep suggesting.
  await a.keyboard.type('#');
  await a.waitForSelector('.mention-suggestions');
  await a.keyboard.type(' ');
  check(!(await a.$('.mention-suggestions')), '"# " (a heading) closes the list');
  await a.keyboard.press('Backspace');
  await a.keyboard.press('Backspace');

  // Alice sees both as links; Bob sees off-topic, and secret as #unknown-channel.
  const aliceLinks = await a.waitForFunction(() => document.querySelectorAll('.dm-message-content .channel-mention').length === 2);
  check(Boolean(aliceLinks), 'alice sees two channel mentions');
  const bobOff = await b.waitForSelector('.dm-message-content .channel-mention:not(.unknown)', { timeout: 10000 });
  check((await bobOff.textContent()) === 'off-topic', 'bob sees #off-topic');
  check((await b.textContent('.dm-message-content .channel-mention.unknown')) === 'unknown-channel', 'and the private one as #unknown-channel');
  await b.mouse.move(5, 5);
  await shot(b, 'bob-sees');
  await bobOff.click();
  await b.waitForURL(`${BASE}/guild/${guild.id}/${offTopic.id}`);
  await b.waitForSelector('.channel-header-name:text("off-topic")');
  check(true, 'clicking it opens #off-topic');
  await b.goBack();
  await b.waitForURL(`${BASE}/guild/${guild.id}/${general.id}`);
  check(true, 'back returns to #general');

  // Editing the message keeps the mentions as chips.
  const own = await a.$('.each-dm-message-wrapper.sent');
  await own.hover();
  await a.click('.each-dm-message-wrapper.sent .icon-button:has([data-icon="pen-to-square"])');
  const chips = await a.waitForFunction(() => [...document.querySelectorAll('.dm-message-content .message-editor .channel-mention, .each-dm-message-wrapper .message-editor .channel-mention')].map((e) => e.textContent).join(' '));
  check((await chips.jsonValue()) === '#off-topic #secret', `the edit box shows the chips (${await chips.jsonValue()})`);
  await shot(a, 'editing');
  await a.keyboard.press('Escape');

  // A DM to Bob, who hasn't opened the guild since reloading: it loads, then shows the name.
  await openChat(a, bob.id);
  await send(a, `meet in <#${offTopic.id}>`);
  await b.goto(`${BASE}/dm/${alice.id}`);
  const dmLink = await b.waitForSelector('.dm-message-content .channel-mention:not(.unknown)', { timeout: 15000 });
  check((await dmLink.textContent()) === 'off-topic', 'in a DM, bob sees #off-topic once his guilds are loaded');
  await dmLink.click();
  await b.waitForURL(`${BASE}/guild/${guild.id}/${offTopic.id}`);
  check(true, 'and clicking it opens the channel');

  // A pasted channel link (Copy Link): bob sees #off-topic, the private one stays a link, and
  // dave (not in the guild) sees both as links.
  const offLink = `${BASE}/guild/${guild.id}/${offTopic.id}`;
  const secretLink = `${BASE}/guild/${guild.id}/${secret.id}`;
  await openChat(a, bob.id);
  await send(a, `links ${offLink} and ${secretLink}`);
  await b.goto(`${BASE}/dm/${alice.id}`);
  const pasted = await b.waitForSelector('.dm-message-content:has-text("links") .channel-mention:not(.unknown)', { timeout: 15000 });
  check((await pasted.textContent()) === 'off-topic', 'a pasted link to #off-topic shows as #off-topic');
  check(await b.$(`.dm-message-content a[href="${secretLink}"]`) !== null, 'one to a channel bob cannot see stays a link');
  check(!(await b.$(`.dm-message-content a[href="${offLink}"]`)), 'the #off-topic link itself is not shown');
  await b.mouse.move(5, 5);
  await shot(b, 'pasted-link');
  await pasted.click();
  await b.waitForURL(offLink);
  check(true, 'clicking it opens the channel');
  const dave = await signUp(browser, 'dave');
  await openChat(a, dave.id);
  await send(a, `try ${offLink}`);
  await dave.page.goto(`${BASE}/dm/${alice.id}`);
  await dave.page.waitForSelector(`.dm-message-content a[href="${offLink}"]`, { timeout: 15000 });
  await dave.page.waitForTimeout(1000);
  check(!(await dave.page.$('.dm-message-content .channel-mention')), 'someone not in the guild sees the link');
  await shot(dave.page, 'pasted-link-outsider');

  // Carol, on a phone, taps one in a DM: the channel opens, chat pane showing.
  await openChat(a, carol.id);
  await send(a, `<#${general.id}> please`);
  const c = carol.page;
  await c.goto(`${BASE}/dm/${alice.id}`);
  const phoneLink = await c.waitForSelector('.dm-message-content .channel-mention:not(.unknown)', { timeout: 15000 });
  await shot(c, 'phone-dm');
  await phoneLink.tap();
  await c.waitForURL(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('.main-wrapper.pane-content .channel-header-name:text("general")');
  await c.waitForTimeout(400);
  const box = await c.$eval('.main-content-wrapper', (el) => el.getBoundingClientRect().left);
  check(Math.abs(box) < 2, `on a phone, tapping it shows #general (chat pane at x=${box})`);
  await shot(c, 'phone-channel');

  console.log('channel mentions: all good');
} finally {
  await browser.close();
}
