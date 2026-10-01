// The guild audit log in a real browser: Bob posts, Carol (a moderator with View Audit Log)
// deletes his message, Alice (the owner) changes a role; the Audit Log in the guild menu shows
// who deleted whose message and where, opens what changed, filters by person and kind, and
// fits a phone. Bob (no permission) has no Audit Log in his menu.
//   node e2e/serve.mjs &   then   node e2e/auditlog.mjs [screenshot dir]
import { launchChrome, signUp, devices } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// The API as the page's user.
const call = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(`/api${u}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return res.status === 204 ? null : res.json();
}, [method, url, body]);

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const a = alice.page;

  const guild = await call(a, 'POST', '/guilds', { name: 'Audit Town' });
  const general = guild.channels[0];
  for (const page of [bob.page, carol.page]) {
    const { code } = await call(a, 'POST', `/guilds/${guild.id}/invites`, {});
    await call(page, 'POST', `/invites/${code}`);
  }
  // Mods: Manage Messages (1 << 3) and View Audit Log (1 << 17), given to Carol.
  const mods = await call(a, 'POST', `/guilds/${guild.id}/roles`, { name: 'Mods', permissions: (1 << 3) | (1 << 17) });
  await call(a, 'PUT', `/guilds/${guild.id}/members/${carol.id}/roles`, { roleIds: [mods.id] });
  const message = await call(bob.page, 'POST', `/channels/${general.id}/messages`, { content: 'something rude' });
  await call(carol.page, 'DELETE', `/guild-messages/${message.id}`);
  await call(a, 'PATCH', `/guilds/${guild.id}/roles/${mods.id}`, { name: 'Moderators', color: 0x2ecc71 });

  // Alice: guild menu → Audit Log.
  await a.goto(new URL(`/guild/${guild.id}/${general.id}`, a.url()).href);
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Audit Log")');
  await a.waitForSelector('.audit-log-entry');
  const rows = await a.$$eval('.audit-log-summary', (els) => els.map((e) => e.textContent));
  console.log(rows.join('\n'));
  check(rows[0].includes('changed the role Moderators'), 'newest first: the role change');
  check(rows.some((r) => r.includes(`deleted a message by ${bob.name} in #general`) && r.startsWith(carol.name)),
    'Carol deleted a message by Bob in #general');
  check(!(await a.textContent('.audit-log-list')).includes('something rude'), "the deleted message's text isn't shown");

  await a.click('.audit-log-entry[data-action="role_update"] .audit-log-row');
  const changes = await a.textContent('.audit-log-entry[data-action="role_update"] .audit-log-changes');
  check(changes.includes('Name: Mods → Moderators') && changes.includes('Colour: none → #2ecc71'), `role changes: ${changes}`);
  await a.click('.audit-log-entry[data-action="message_delete"] .audit-log-row');
  check((await a.textContent('.audit-log-entry[data-action="message_delete"] .audit-log-changes')).includes('Sent '), 'when it was sent');
  await shot(a, 'audit-log-desktop');

  // Filters: only messages; only what Alice did.
  await a.selectOption('select[aria-label="Filter by action"]', 'messages');
  await a.waitForFunction(() => [...document.querySelectorAll('.audit-log-entry')].every((e) => e.dataset.action.startsWith('message_')));
  check((await a.$$('.audit-log-entry')).length === 1, 'Messages filter: just the delete');
  await a.selectOption('select[aria-label="Filter by action"]', '');
  await a.selectOption('select[aria-label="Filter by member"]', String(alice.id));
  await a.waitForFunction((id) => {
    const rows = [...document.querySelectorAll('.audit-log-entry')];
    return rows.length > 0 && rows.every((e) => e.dataset.actor === String(id));
  }, alice.id);
  const mine = await a.$$eval('.audit-log-summary', (els) => els.map((e) => e.textContent));
  check(mine.length === 5 && mine.every((r) => r.startsWith(alice.name)), 'filtered to Alice');
  await a.keyboard.press('Escape');

  // Bob can't see it.
  const b = bob.page;
  await b.goto(new URL(`/guild/${guild.id}/${general.id}`, b.url()).href);
  await b.waitForSelector('#dm-input');
  await b.click('.guild-header-button');
  await b.waitForSelector('.guild-menu');
  check(!(await b.$('.guild-menu-item:has-text("Audit Log")')), 'no Audit Log for Bob');

  // Carol, on a phone.
  const c = carol.page;
  await c.goto(new URL(`/guild/${guild.id}/${general.id}`, c.url()).href);
  await c.waitForSelector('#dm-input');
  // Swipe the chat away to the channel list (CDP touch, as e2e/panes.mjs does).
  const { width, height } = c.viewportSize();
  const cdp = await c.context().newCDPSession(c);
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: height / 2 }] });
  await touch('touchStart', 40);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', 40 + (width * 0.6 * i) / 10);
    await c.waitForTimeout(16);
  }
  await touch('touchEnd');
  await c.waitForFunction(() => document.querySelector('.main-wrapper.pane-list'));
  await c.waitForTimeout(400);
  await c.click('.guild-header-button');
  await c.click('.guild-menu-item:has-text("Audit Log")');
  await c.waitForSelector('.audit-log-entry');
  const overflow = await c.evaluate(() => {
    const dialog = document.querySelector('.audit-log-dialog').getBoundingClientRect();
    return dialog.right > window.innerWidth + 0.5 || document.documentElement.scrollWidth > window.innerWidth;
  });
  check(!overflow, 'fits the phone width');
  await shot(c, 'audit-log-phone');
  console.log('audit log checks passed');
} finally {
  await browser.close();
}
