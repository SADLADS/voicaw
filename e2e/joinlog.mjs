// The join log in a real browser: Alice turns it on in Guild Settings → Overview (#general),
// Bob on a phone joins through an invite and "bob joined the guild." appears live for Alice (not
// unread for Bob, who sees it too); the name opens his profile card; leaves are off, so his
// leaving posts nothing until Alice ticks "Also say who left", then it does; the audit log says
// so; Off turns it off.
//   node e2e/serve.mjs &   then   node e2e/joinlog.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

// The app's own API, as the logged-in person on `page`.
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

async function openOverview(a) {
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.waitForSelector('.guild-join-log select');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Join Log Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildId = Number(new URL(a.url()).pathname.split('/')[2]);

  // Guild Settings → Overview → Join log: Off, leaves unticked and disabled until a channel.
  await openOverview(a);
  check(await a.inputValue('.guild-join-log select') === '', 'off by default');
  check(await a.isDisabled('.guild-join-log input[type=checkbox]'), '"Also say who left" waits for a channel');
  await a.selectOption('.guild-join-log select', { label: '#general' });
  await a.waitForSelector('.guild-join-log .success-msg');
  check(!(await a.isDisabled('.guild-join-log input[type=checkbox]')), 'a channel enables the leaves box');
  await shot(a, 'settings');
  await a.keyboard.press('Escape');

  // Bob joins: the row appears live for Alice.
  const invite = await call(a, 'POST', `/guilds/${guildId}/invites`, {});
  await b.goto(`${BASE}/invite/${invite.body.code}`);
  await b.click('.invite-card button:has-text("Accept invite")');
  await b.waitForURL(/\/guild\/\d+/, { timeout: 10000 });
  const row = await a.waitForSelector(`.join-log:has-text("${bob.name} joined the guild.")`, { timeout: 10000 });
  check(!(await row.evaluate((el) => el.classList.contains('left'))), 'Alice sees Bob join, live');
  await shot(a, 'joined');

  // Bob sees his own row in #general, and it isn't unread for him.
  await b.waitForSelector(`.join-log:has-text("${bob.name} joined the guild.")`, { timeout: 10000 });
  check(await b.locator('.new-divider').count() === 0, 'his own join is read for Bob (no "New" line)');
  await shot(b, 'phone-joined');

  // The name opens his profile card.
  await a.click(`.join-log-name:has-text("${bob.name}")`);
  await a.waitForSelector('.profile-popover', { timeout: 5000 });
  check(true, 'the name opens the profile card');
  await a.keyboard.press('Escape');

  // Leaves are off: Bob leaving and coming back posts only his second join.
  await call(b, 'DELETE', `/guilds/${guildId}/members/me`);
  const again = await call(a, 'POST', `/guilds/${guildId}/invites`, {});
  await call(b, 'POST', `/invites/${again.body.code}`);
  await a.waitForFunction(() => document.querySelectorAll('.join-log').length === 2, null, { timeout: 10000 });
  check(await a.locator('.join-log.left').count() === 0, 'no leave row while leaves are off');

  // With "Also say who left", a kick shows as Bob having left.
  await openOverview(a);
  await a.check('.guild-join-log input[type=checkbox]');
  await a.waitForSelector('.guild-join-log .success-msg');
  await a.keyboard.press('Escape');
  const bobId = (await call(a, 'GET', `/guilds/${guildId}/members`)).body.find((m) => m.username === bob.name).id;
  await call(a, 'DELETE', `/guilds/${guildId}/members/${bobId}`);
  await a.waitForSelector(`.join-log.left:has-text("${bob.name} left the guild.")`, { timeout: 10000 });
  check(true, 'a kick reads "left"');
  await shot(a, 'left');

  // The audit log says what changed.
  const audit = await call(a, 'GET', `/guilds/${guildId}/audit-log`);
  const changes = audit.body.entries.filter((e) => e.action === 'guild_update').map((e) => e.details.changes);
  check(changes.some((c) => c.join_log?.[1] === 'general') && changes.some((c) => c.join_log_leaves?.[1] === true), 'audit log has both changes');

  // Off again.
  await openOverview(a);
  await a.selectOption('.guild-join-log select', '');
  await a.waitForSelector('.guild-join-log .success-msg');
  check(await a.isDisabled('.guild-join-log input[type=checkbox]'), 'Off: the leaves box is disabled again');
  await a.keyboard.press('Escape');

  // Dark theme screenshot of the rows.
  await a.emulateMedia({ colorScheme: 'dark' });
  await shot(a, 'dark');
  console.log('all good');
} finally {
  await browser.close();
}
