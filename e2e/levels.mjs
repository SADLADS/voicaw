// Levels in a real browser: the owner turns things on in Guild Settings → Levels (XP per level,
// a short name, cooldown off), Bob's messages earn XP and his level shows beside his picture in
// the member list, live; his card shows his level, rank and progress, and the owner sets his
// level there (Manage Levels); the leaderboard lists him; the audit log has the changes; at one
// XP per level XP is never mentioned; Bob can't change levels. Carol, on a phone, sees the
// leaderboard and no settings. Turned off, the badges go.
//   node e2e/serve.mjs &   then   node e2e/levels.mjs [screenshot dir]
import { launchChrome, signUp, send, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

// The API as the page's user.
const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, path, body]);

const openSettingsTab = async (page, tab) => {
  await page.click('.guild-header-button');
  await page.click('.guild-menu-item:has-text("Guild Settings")');
  await page.click(`.settings-tab:has-text("${tab}")`);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Level Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildId = new URL(a.url()).pathname.split('/')[2];
  const invite = await call(a, 'POST', `/guilds/${guildId}/invites`, {});
  await b.goto(`${BASE}/invite/${invite.body.code}`);
  await b.click('.invite-card button:has-text("Accept invite")');
  await b.waitForURL(/\/guild\/\d+/, { timeout: 10000 });

  // Guild Settings → Levels: off by default, turned on; defaults shown as placeholders.
  await openSettingsTab(a, 'Levels');
  await a.waitForSelector('.level-settings');
  check(!(await a.isChecked('.level-settings > .role-toggle input')), 'levels are off by default');
  await a.click('.level-settings > .role-toggle input');
  check(await a.getAttribute('#level-levelShort', 'placeholder') === 'lvl', 'short name defaults to lvl');
  check((await a.locator('.level-source').count()) === 9, 'nine things to earn XP for');
  await a.fill('#level-per', '20');
  await a.fill('#level-levelShort', 'rk');
  await a.fill('#level-cooldown', '0');
  await shot(a, 'settings');
  await a.click('.level-settings button:has-text("Save")');
  await a.waitForSelector('.level-settings .success-msg:has-text("Saved")');
  check(true, 'settings saved');
  await a.keyboard.press('Escape');

  // Bob's three messages: 30 XP, level 1 at 20 per level; his badge appears for Alice, live.
  const bobRow = `.member-row[data-user-id="${bob.id}"]`;
  await a.waitForSelector(bobRow);
  check(!(await a.locator(`${bobRow} .member-level`).count()), 'no badge at level 0');
  for (const text of ['one', 'two', 'three']) await send(b, text);
  await a.waitForSelector(`${bobRow} .member-level:has-text("1 rk")`, { timeout: 10000 });
  check(true, 'badge "1 rk" under Bob\'s name, live');
  await shot(a, 'member-list');

  // His card: level, rank, progress; Alice (owner, so Manage Levels) sets him to level 5.
  await a.click(bobRow);
  const card = a.locator('.member-card');
  await card.locator('.member-card-rank:has-text("#1")').waitFor();
  check((await card.textContent()).includes('Level 1'), 'card: Level 1, #1');
  check((await card.textContent()).includes('10 / 20 XP'), 'card: 10 / 20 XP');
  await card.locator('button:has-text("Change")').click();
  await card.locator('input[aria-label="Amount"]').fill('5');
  await shot(a, 'card-edit');
  await card.locator('button:has-text("Save")').click();
  await a.waitForSelector(`${bobRow} .member-level:has-text("5 rk")`);
  await card.locator('text=0 / 20 XP').waitFor();
  check(true, 'set to level 5: badge and card follow');
  await shot(a, 'card');

  // Bob can't change anyone's level, nor the settings.
  const refused = await call(b, 'PATCH', `/guilds/${guildId}/levels/members/${bob.id}`, { level: 99 });
  check(refused.status === 403, 'Bob refused without Manage Levels');

  // The leaderboard.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Leaderboard")');
  await a.waitForSelector('.leaderboard-row');
  const first = await a.textContent('.leaderboard-row');
  check(first.includes(bob.name) && first.includes('100 XP') && first.includes('Level 5'), `leaderboard: ${first}`);
  await shot(a, 'leaderboard');
  await a.keyboard.press('Escape');

  // The audit log.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Audit Log")');
  await a.waitForSelector('text=changed the level settings');
  await a.waitForSelector('text=changed the XP of');
  check(true, 'audit log: settings and XP changes');
  await a.keyboard.press('Escape');

  // One XP per level: no XP anywhere.
  await call(a, 'PATCH', `/guilds/${guildId}/levels`, { xpPerLevel: 1 });
  await a.waitForSelector(`${bobRow} .member-level:has-text("100 rk")`);
  await a.click(bobRow);
  const plain = await a.locator('.member-card').textContent();
  check(plain.includes('Level 100') && !plain.includes('XP'), 'one XP per level: XP never mentioned');
  await shot(a, 'card-levels-only');

  // Carol on a phone: the leaderboard fits, and no Guild Settings for her.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const p = carol.page;
  const phoneInvite = await call(a, 'POST', `/guilds/${guildId}/invites`, {});
  await p.goto(`${BASE}/invite/${phoneInvite.body.code}`);
  await p.click('.invite-card button:has-text("Accept invite")');
  await p.waitForURL(/\/guild\/\d+/, { timeout: 10000 });
  // Slide back to the channel list, where the guild's menu is.
  await p.waitForSelector('#dm-input');
  await p.waitForTimeout(800);
  await p.goBack();
  await p.waitForTimeout(600);
  await p.click('.guild-header-button');
  check(!(await p.locator('.guild-menu-item:has-text("Guild Settings")').count()), 'Carol has no Guild Settings');
  await p.click('.guild-menu-item:has-text("Leaderboard")');
  await p.waitForSelector('.leaderboard-row');
  const overflow = await p.evaluate(() => {
    const dialog = document.querySelector('.leaderboard-dialog');
    return dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > window.innerWidth;
  });
  check(!overflow, 'phone: leaderboard fits');
  await shot(p, 'phone-leaderboard');
  await p.keyboard.press('Escape');

  // Turned off: the badges go, and the menu has no leaderboard.
  await call(a, 'PATCH', `/guilds/${guildId}/levels`, { enabled: false });
  await a.waitForFunction((row) => !document.querySelector(`${row} .member-level`), bobRow);
  check(true, 'turned off: badges gone');
} finally {
  await browser.close();
}
