// The channel list's menus: right-click a channel (desktop) for Mark As Read, Mute Channel ▸,
// Notification Settings ▸ (its own level), Copy Link, and for managers Edit / Duplicate (same
// permissions, just below) / Delete; keys work; it stays on screen. A category's menu.
// On a phone there are no cog buttons: touch and hold opens the menu as a sheet (submenus
// replace it, with Back), and holding then moving still drags a channel (with Manage Channels).
//   node e2e/serve.mjs &   then   node e2e/channelmenu.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

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

const MANAGE_CHANNELS = 1 << 4;

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const dave = await signUp(browser, 'dave', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Menus' });
  const general = guild.channels[0];
  const everyone = guild.roles.find((r) => r.is_everyone);
  const random = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'random', categoryId: general.category_id });
  await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'third', categoryId: general.category_id });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  for (const u of [bob, carol, dave]) await api(u.page, 'POST', `/invites/${invite.code}`);
  // Dave may manage channels.
  const mods = await api(alice.page, 'POST', `/guilds/${guild.id}/roles`, { name: 'mods', permissions: MANAGE_CHANNELS });
  await api(alice.page, 'PUT', `/guilds/${guild.id}/members/${dave.id}/roles`, { roleIds: [mods.id] });
  // Bob posts in #random (unread for alice), then it's made read-only for @everyone (so a copy
  // has to carry that).
  await api(bob.page, 'POST', `/channels/${random.id}/messages`, { content: 'hi' });
  await api(alice.page, 'PUT', `/guilds/${guild.id}/channels/${random.id}/overrides/role/${everyone.id}`, { allow: 0, deny: 1 << 1 });

  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  const row = (name) => a.locator('.guild-channel', { has: a.locator(`.guild-channel-name:text-is("${name}")`) });
  const items = (page, sel) => page.$$eval(`${sel} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));

  await a.waitForSelector('.guild-channel.unread');
  await row('random').locator('.guild-channel-link').click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  check(JSON.stringify(await items(a, '.context-menu')) === JSON.stringify([
    'Mark As Read', 'Mute Channel', 'Notification Settings', 'Copy Link', 'Copy Channel ID', 'Edit Channel', 'Duplicate Channel', 'Delete Channel',
  ]), `the owner's channel menu: ${(await items(a, '.context-menu')).join(', ')}`);
  await shot(a, 'desktop-menu');
  await a.click('.context-menu >> text=Mark As Read');
  await a.waitForFunction(() => !document.querySelector('.guild-channel.unread'));
  check(!(await a.$('.context-menu')), 'Mark As Read: #random is read and the menu closed');

  // Notification Settings opens beside the menu on hover.
  await row('random').locator('.guild-channel-link').click({ button: 'right' });
  await a.hover('.context-menu >> text=Notification Settings');
  await a.waitForSelector('.context-submenu');
  const main = await a.locator('.context-menu:not(.context-submenu)').boundingBox();
  const sub = await a.locator('.context-submenu').boundingBox();
  check(sub.x >= main.x + main.width - 4, `the submenu opens to the right (${Math.round(main.x + main.width)} → ${Math.round(sub.x)})`);
  check((await a.getAttribute('.context-submenu [role="menuitemradio"]:has-text("Use Guild Default")', 'aria-checked')) === 'true', 'the guild default is ticked');
  await shot(a, 'desktop-notifications');
  await a.click('.context-submenu >> text=All messages');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  const levels = await api(a, 'GET', '/channel-notifications');
  check(levels.length === 1 && levels[0].channel_id === random.id && levels[0].level === 'all', '#random set to All messages');
  await row('random').locator('.guild-channel-link').click({ button: 'right' });
  check((await a.textContent('.context-menu [aria-haspopup]:has-text("Notification Settings") small')) === 'All messages', 'and the menu says so');

  // Keys: the first item (Mute Channel) has the focus, → opens it with the focus, ← goes
  // back, ↓ moves on, Escape closes.
  await a.mouse.move(5, 5);
  await a.keyboard.press('ArrowRight');
  await a.waitForSelector('.context-submenu');
  check(await a.evaluate(() => document.activeElement?.textContent === 'For 15 minutes'), '→ opens Mute Channel with its first choice focused');
  await a.keyboard.press('ArrowLeft');
  check(await a.evaluate(() => !document.querySelector('.context-submenu') && document.activeElement?.textContent.startsWith('Mute Channel')), '← goes back to Mute Channel');
  await a.keyboard.press('ArrowDown');
  check(await a.evaluate(() => document.activeElement?.textContent.startsWith('Notification Settings')), '↓ moves to Notification Settings');
  await a.keyboard.press('Escape');
  check(!(await a.$('.context-menu')), 'Escape closes it');

  // Copy Link.
  await row('general').locator('.guild-channel-link').click({ button: 'right' });
  await a.click('.context-menu >> text=Copy Link');
  await a.waitForSelector('.context-menu >> text=Link copied');
  const copied = await a.evaluate(() => navigator.clipboard.readText());
  check(copied === `${BASE}/guild/${guild.id}/${general.id}`, `Copy Link copied ${copied}`);
  await a.waitForSelector('.context-menu', { state: 'detached' });

  // Duplicate #random: same permissions (read-only), right below it, opened.
  await row('random').locator('.guild-channel-link').click({ button: 'right' });
  await a.click('.context-menu >> text=Duplicate Channel');
  await a.waitForSelector('#clone-channel-name');
  await shot(a, 'desktop-duplicate');
  await a.fill('#clone-channel-name', 'random copy');
  await a.click('.vc-dialog button:has-text("Duplicate Channel")');
  await a.waitForFunction(() => document.querySelector('.guild-channel.active .guild-channel-name')?.textContent === 'random-copy');
  const order = await a.$$eval('.guild-channel-name', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(order) === JSON.stringify(['Calendar', 'general', 'random', 'random-copy', 'third']), `the copy is right below it and open (${order.join(', ')})`);
  const copyId = Number(new URL(a.url()).pathname.split('/').pop());
  const overrides = await api(a, 'GET', `/guilds/${guild.id}/channels/${copyId}/overrides`);
  check(overrides.length === 1 && overrides[0].deny === 1 << 1, 'with the same permissions (read-only for @everyone)');

  // Delete it from its menu.
  await row('random-copy').locator('.guild-channel-link').click({ button: 'right' });
  await a.click('.context-menu >> text=Delete Channel');
  await a.click('.vc-dialog button:has-text("Delete Channel")');
  await a.waitForFunction(() => ![...document.querySelectorAll('.guild-channel-name')].some((e) => e.textContent === 'random-copy'));
  check(!a.url().endsWith(`/${copyId}`), 'Delete Channel: gone, and the page left it');

  // A category's menu; a right-click at the window's corner stays on screen.
  await a.click('.guild-category-toggle', { button: 'right' });
  check(JSON.stringify(await items(a, '.context-menu')) === JSON.stringify(['Collapse Category', 'Copy Category ID', 'Edit Category', 'Create Channel', 'Delete Category']), 'the category menu');
  await a.keyboard.press('Escape');
  // Shrink the window so #third is the last row above the user panel, and right-click its far
  // end: the menu has to go up.
  const full = a.viewportSize();
  const thirdRow = await row('third').boundingBox();
  const panel = await a.locator('.user-panel').boundingBox();
  await a.setViewportSize({ width: 500, height: Math.ceil(thirdRow.y + thirdRow.height + panel.height + 2) });
  const shrunk = a.viewportSize();
  const at = await row('third').boundingBox();
  await a.mouse.click(at.x + at.width - 4, at.y + at.height - 4, { button: 'right' });
  const corner = await a.locator('.context-menu').boundingBox();
  check(corner.x >= 0 && corner.y >= 0 && corner.x + corner.width <= shrunk.width && corner.y + corner.height <= shrunk.height,
    `a menu opened at the bottom of the window stays on screen (${Math.round(corner.y)}–${Math.round(corner.y + corner.height)} of ${shrunk.height})`);
  await shot(a, 'desktop-bottom');
  await a.keyboard.press('Escape');
  await a.setViewportSize(full);

  // Bob (a member): no manager items.
  const b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  await b.locator('.guild-channel-link', { hasText: 'general' }).click({ button: 'right' });
  check(JSON.stringify(await items(b, '.context-menu')) === JSON.stringify(['Mute Channel', 'Notification Settings', 'Copy Link', 'Copy Channel ID']), "a member's menu has no manager items");

  // Phones. Touch and hold through CDP (real touches, like a finger).
  const hold = async (page, locator, { moveBy = 0 } = {}) => {
    const cdp = await page.context().newCDPSession(page);
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const touch = (type, ty) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: ty }] });
    await touch('touchStart', y);
    await page.waitForTimeout(600);
    for (let step = 1; moveBy && step <= 8; step++) {
      await touch('touchMove', y + (moveBy * step) / 8);
      await page.waitForTimeout(30);
    }
    await touch('touchEnd');
  };

  // Carol (a member, phone): no cogs; holding #random opens the sheet without opening the channel.
  const c = carol.page;
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {}); // the channel list
  await c.waitForTimeout(400);
  check(await c.locator('.guild-sidebar-icon-button').count() === 0, 'no cog buttons on a phone');
  await hold(c, c.locator('.guild-channel-link', { hasText: 'random' }));
  await c.waitForSelector('.context-sheet');
  check(c.url().endsWith(`/${general.id}`), "holding didn't open #random");
  await c.waitForTimeout(300);
  await shot(c, 'phone-sheet');
  await c.tap('.context-sheet >> text=Mute Channel');
  await c.waitForSelector('.context-sheet >> text=For 15 minutes');
  check((await c.textContent('.context-sheet-title')).trim() === 'Mute Channel', 'Mute Channel replaces the sheet, titled');
  await shot(c, 'phone-mute');
  await c.tap('.context-sheet-back');
  await c.waitForSelector('.context-sheet >> text=Copy Link');
  await c.tap('.context-sheet >> text=Mute Channel');
  await c.tap('.context-sheet >> text=For 1 hour');
  await c.waitForSelector('.guild-channel.muted');
  check(!(await c.$('.context-sheet')), 'muted from the sheet, which closed');
  // A tap outside closes it.
  await hold(c, c.locator('.guild-channel-link', { hasText: 'general' }));
  await c.waitForSelector('.context-sheet');
  await c.tap('.action-sheet-backdrop', { position: { x: 20, y: 20 } });
  await c.waitForSelector('.context-sheet', { state: 'detached' });
  check(true, 'a tap above the sheet closes it');

  // Dave (Manage Channels, phone): holding and lifting opens the menu with manager items;
  // holding and moving drags #third above #random.
  const d = dave.page;
  await d.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await d.waitForSelector('#dm-input');
  await d.goBack().catch(() => {});
  await d.waitForTimeout(400);
  await hold(d, d.locator('.guild-channel-link', { hasText: 'general' }));
  await d.waitForSelector('.context-sheet');
  const daveItems = await items(d, '.context-sheet');
  check(daveItems.includes('Edit Channel') && daveItems.includes('Duplicate Channel') && daveItems.includes('Delete Channel'), `a manager's sheet: ${daveItems.join(', ')}`);
  await shot(d, 'phone-manager-sheet');
  await d.tap('.action-sheet-backdrop', { position: { x: 20, y: 20 } });
  await d.waitForSelector('.context-sheet', { state: 'detached' });
  const third = d.locator('.guild-channel-link', { hasText: 'third' });
  const randomBox = await d.locator('.guild-channel-link', { hasText: 'random' }).boundingBox();
  const thirdBox = await third.boundingBox();
  await hold(d, third, { moveBy: randomBox.y - thirdBox.y - 6 });
  await d.waitForFunction(() => [...document.querySelectorAll('.guild-channel-name')].map((e) => e.textContent).join() === 'general,third,random', null, { timeout: 5000 });
  check(!(await d.$('.context-sheet')), 'holding then moving drags the channel (no menu)');

  console.log('channelmenu: ok');
} catch (err) {
  console.error('channelmenu: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
