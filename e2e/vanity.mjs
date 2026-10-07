// Vanity invites in a real browser: the owner sets one in Guild Settings → Invites (link,
// uses, Copy), Invite People shows it under the fresh link, Bob on a phone opens it typed in
// another case (no "invited by"), joins, and it counts a use; a link to it in a message gets
// its card; the audit log says so; removed, the link stops working. Bob (not the owner) can't
// set one.
//   node e2e/serve.mjs &   then   node e2e/vanity.mjs [screenshot dir]
import { launchChrome, signUp, send, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const code = `vanity-${Date.now().toString(36)}`;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Vanity Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildPath = new URL(a.url()).pathname;

  // Guild Settings → Invites: the Vanity URL section, set in mixed case with spaces.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.click('.settings-tab:has-text("Invites")');
  await a.waitForSelector('#guild-vanity-code');
  await a.fill('#guild-vanity-code', ` ${code.toUpperCase()} `);
  await a.click('.guild-vanity button:has-text("Save")');
  await a.waitForSelector(`.guild-vanity-link:has-text("/invite/${code}")`);
  check((await a.textContent('.guild-vanity-link')).includes('0 uses'), 'set: link shown, lowercase, 0 uses');
  check((await a.inputValue('#guild-vanity-code')) === code, 'the box shows the saved code');
  await shot(a, 'settings');
  await a.keyboard.press('Escape');

  // Invite People shows it under the fresh link.
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const vanityLink = await a.inputValue('#invite-vanity-link');
  check(vanityLink === `${BASE}/invite/${code}`, `Invite People offers ${vanityLink}`);
  await shot(a, 'invite-dialog');
  await a.keyboard.press('Escape');

  // A link to it in the channel gets the invite card.
  await send(a, `come in: ${vanityLink}`);
  await a.waitForSelector('.invite-embed .invite-embed-name:has-text("Vanity Guild")', { timeout: 10000 });
  check(true, 'the vanity link in a message gets its card');

  // Bob, on a phone, types it in another case: no "invited by", joins.
  await b.goto(`${BASE}/invite/${code.toUpperCase()}`);
  await b.waitForSelector('.invite-card h4:has-text("Vanity Guild")');
  const cardText = await b.textContent('.invite-card');
  check(cardText.includes('You’ve been invited to join') && !cardText.includes(alice.name), 'invite page: no inviter named');
  await shot(b, 'invite-page');
  await b.click('.invite-card button:has-text("Accept invite")');
  await b.waitForURL(/\/guild\/\d+/, { timeout: 10000 });
  check(true, 'Bob joined through it');

  // Bob can't set one (not the owner): the API refuses.
  const refused = await b.evaluate(async (path) => {
    const res = await fetch(`/api/guilds/${path.split('/')[2]}/vanity-url`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bobs-guild' }),
    });
    return res.status;
  }, guildPath);
  check(refused === 403, 'non-owner refused');

  // Alice's settings count the use; the owner's phone layout fits.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.click('.settings-tab:has-text("Invites")');
  await a.waitForSelector('.guild-vanity-link:has-text("1 use")');
  check(true, 'one use counted');

  // Audit log.
  await a.keyboard.press('Escape');
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Audit Log")');
  await a.waitForSelector('.audit-log-entry');
  const rows = await a.$$eval('.audit-log-summary', (els) => els.map((e) => e.textContent));
  check(rows.some((r) => r.includes(`set the vanity invite to ${code}`)), 'audit log: set the vanity invite');
  await a.keyboard.press('Escape');

  // Removed: the link stops working.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.click('.settings-tab:has-text("Invites")');
  await a.click('.guild-vanity button:has-text("Remove")');
  await a.waitForSelector('.guild-vanity .success-msg:has-text("Vanity URL removed")');
  check(!(await a.$('.guild-vanity-link')), 'removed: no link shown');
  await b.goto(`${BASE}/invite/${code}`);
  await b.waitForSelector('.invite-card:has-text("Invite invalid")', { timeout: 10000 });
  check(true, 'removed link is invalid');

  // Phone: an owner (Carol, her own guild) sets one; the settings tab fits the screen.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const p = carol.page;
  const carolGuild = await p.evaluate(async () => {
    const res = await fetch('/api/guilds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Carol Guild' }),
    });
    return (await res.json()).id;
  });
  await p.goto(`${BASE}/guild/${carolGuild}`);
  await p.waitForSelector('#dm-input', { timeout: 15000 });
  // Slide back to the channel list, where the guild menu is.
  await p.click('.pane-back-button');
  await p.waitForTimeout(500);
  await p.click('.guild-header-button');
  await p.click('.guild-menu-item:has-text("Guild Settings")');
  await p.click('.settings-tab:has-text("Invites")');
  await p.fill('#guild-vanity-code', `${code}-again`);
  await p.click('.guild-vanity button:has-text("Save")');
  await p.waitForSelector(`.guild-vanity-link:has-text("${code}-again")`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth
    || [...document.querySelectorAll('.guild-vanity *')].some((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5));
  await shot(p, 'settings-phone');
  check(!overflow, 'phone: the Vanity URL section fits');
  console.log('vanity: ok');
} catch (err) {
  console.error('vanity: FAILED', err.message.split('\n')[0]);
  if (shots) for (const [i, page] of browser.contexts().flatMap((c) => c.pages()).entries()) await page.screenshot({ path: `${shots}/failed-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
