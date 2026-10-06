// Right-click menus beyond the channel list's rows (see channelmenu.mjs for those): the browser's
// own menu is off everywhere, ours instead (text boxes, links: see textmenu.mjs), Shift keeps
// the browser's; a guild's icon on the rail
// (read, invite, notifications, settings, copy link, leave); the channel list's empty space
// (create channel/category, invite); a conversation in the DM list (pin to the top, mute so
// it doesn't ping, call). On a phone, touch and hold opens each as a sheet, and hold-then-move
// still drags a guild on the rail.
//   node e2e/serve.mjs &   then   node e2e/menus.mjs [screenshot dir]
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
const items = (page, sel) => page.$$eval(`${sel} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Alpha' });
  const beta = await api(alice.page, 'POST', '/guilds', { name: 'Beta' });
  const general = guild.channels[0];
  for (const g of [guild, beta]) {
    const invite = await api(alice.page, 'POST', `/guilds/${g.id}/invites`, {});
    await api(bob.page, 'POST', `/invites/${invite.code}`);
    await api(carol.page, 'POST', `/invites/${invite.code}`);
  }
  const dm = (from, to, content) => api(from.page, 'POST', '/dm-send', { recipient_id: to.id, content });

  // The browser's menu: off everywhere (ours in the message box and on links), but Shift keeps
  // it. (Headless Chrome draws no menu: what counts is whether the event was cancelled.)
  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await api(a, 'POST', `/channels/${general.id}/messages`, { content: 'see https://example.com' });
  await a.waitForSelector('.dm-message-content a[href]');
  const cancelled = (selector, shiftKey = false) => a.evaluate(([sel, shift]) => {
    const el = document.querySelector(sel);
    return !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: shift }));
  }, [selector, shiftKey]);
  check(await cancelled('.chat-recipient-header, .channel-header, h4'), "the browser's menu is off on the page");
  check(await cancelled('#dm-input'), 'and in the message box (ours instead)');
  check(await cancelled('.dm-message-content a[href]'), 'and on a link in a message (ours instead)');
  check(!(await cancelled('#dm-input', true)), 'but Shift+right-click keeps it');
  await a.keyboard.press('Escape');

  // The rail: right-click Alpha.
  await a.click('.rail-guild[aria-label="Alpha"]', { button: 'right' });
  await a.waitForSelector('.context-menu');
  const railItems = await items(a, '.context-menu');
  check(same(railItems, ['Invite People', 'Notification Settings', 'Guild Settings', 'Audit Log', 'Copy Link', 'Copy Guild ID']), `the owner's guild menu: ${railItems.join(', ')}`);
  await a.hover('.context-menu >> text=Notification Settings');
  await a.waitForSelector('.context-submenu');
  await shot(a, 'rail-menu');
  await a.click('.context-submenu >> text=Nothing');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check((await api(a, 'GET', `/guilds/${guild.id}`)).my_notify_level === 'none', 'Notification Settings → Nothing saved for Alpha');
  await a.click('.rail-guild[aria-label="Alpha"]', { button: 'right' });
  await a.click('.context-menu >> text=Copy Link');
  await a.waitForSelector('.context-menu >> text=Link copied');
  check((await a.evaluate(() => navigator.clipboard.readText())) === `${BASE}/guild/${guild.id}`, 'Copy Link copied the guild link');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await a.click('.rail-guild[aria-label="Beta"]', { button: 'right' });
  await a.click('.context-menu >> text=Invite People');
  await a.waitForSelector('.vc-dialog');
  check(/Beta/.test(await a.textContent('.vc-dialog')), 'Invite People opens the invite dialog for that guild');
  await a.keyboard.press('Escape');

  // The channel list's empty space.
  const list = await a.locator('.guild-channel-list').boundingBox();
  await a.mouse.click(list.x + list.width / 2, list.y + list.height - 20, { button: 'right' });
  await a.waitForSelector('.context-menu');
  check(same(await items(a, '.context-menu'), ['Create Channel', 'Create Category', 'Invite People']), 'empty space: Create Channel, Create Category, Invite People');
  await shot(a, 'list-menu');
  await a.click('.context-menu >> text=Create Channel');
  await a.waitForSelector('.vc-dialog:has-text("Create channel")');
  check(true, 'Create Channel opens the dialog');
  await a.keyboard.press('Escape');

  // The DM list: alice pins carol, mutes bob.
  await dm(bob, alice, 'hi alice');
  await dm(carol, alice, 'hey');
  await a.goto(`${BASE}/dm/${bob.id}`);
  await a.waitForSelector('#dm-input');
  const rowNames = () => a.$$eval('.dm-user-list-container .dm-user .dm-user-name', (els) => els.map((e) => e.textContent));
  const bobName = (await rowNames()).find((n) => n.startsWith('bob'));
  const carolName = (await rowNames()).find((n) => n.startsWith('carol'));
  // The list keeps the server's order (the throwaway database may hold users from earlier runs):
  // pin whichever of the two isn't first.
  const first = (await rowNames())[0];
  const pinName = first === carolName ? bobName : carolName;
  const row = (name) => a.locator('.dm-user', { has: a.locator(`.dm-user-name:text-is("${name}")`) });
  await row(pinName).click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  const dmItems = await items(a, '.context-menu');
  check(dmItems.includes('Pin Conversation') && dmItems.includes('Mute Conversation'), `a person's menu: ${dmItems.join(', ')}`);
  await a.click('.context-menu >> text=Pin Conversation');
  await a.waitForFunction((name) => document.querySelector('.dm-user-list-container .dm-user .dm-user-name')?.textContent === name, pinName);
  check(await row(pinName).locator('[aria-label="Pinned"]').count() === 1, `pinned: ${pinName} moves to the top, with a pin`);
  await row(bobName).click({ button: 'right' });
  await a.hover('.context-menu >> text=Mute Conversation');
  await a.click('.context-submenu >> text=For 1 hour');
  await a.waitForSelector('.dm-user.muted');
  await a.mouse.move(600, 400);
  await shot(a, 'dm-list');
  const settings = await api(a, 'GET', '/conversation-settings');
  check(settings.some((s) => s.muted) && settings.some((s) => s.pinned_at), 'saved for her other devices (one pinned, bob muted)');

  // Bob's new message: no dot on the DMs icon while alice is in a guild (carol's read first).
  await api(a, 'POST', `/dm-mark-read/${carol.id}`);
  await api(a, 'POST', `/dm-mark-read/${bob.id}`);
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await dm(bob, alice, 'are you there?');
  await a.waitForTimeout(1500);
  check(!(await a.locator('.nav-item:has([aria-label="Direct Messages"]) .dot').evaluate((el) => el.classList.contains('visible'))), "a muted DM doesn't light the DMs icon");
  await dm(carol, alice, 'ping');
  await a.waitForSelector('.nav-item:has([aria-label="Direct Messages"]) .dot.visible', { timeout: 10000 });
  check(true, 'an unmuted one does');

  // Phone: touch and hold.
  const c = carol.page;
  const hold = async (locator, { moveBy = 0 } = {}) => {
    const cdp = await c.context().newCDPSession(c);
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const touch = (type, ty) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: ty }] });
    await touch('touchStart', y);
    await c.waitForTimeout(600);
    for (let step = 1; moveBy && step <= 8; step++) {
      await touch('touchMove', y + (moveBy * step) / 8);
      await c.waitForTimeout(30);
    }
    await touch('touchEnd');
  };
  const closeSheet = async () => {
    await c.tap('.action-sheet-backdrop', { position: { x: 20, y: 20 } });
    await c.waitForSelector('.context-sheet', { state: 'detached' });
  };
  await c.goto(`${BASE}/dm/${alice.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {});
  await c.waitForTimeout(400);
  const before = c.url();
  await hold(c.locator('.dm-user-list-container .dm-user').first());
  await c.waitForSelector('.context-sheet');
  check(c.url() === before, "holding a conversation opens its sheet, not the chat");
  await c.waitForTimeout(300);
  await shot(c, 'phone-dm-sheet');
  await c.tap('.context-sheet >> text=Pin Conversation');
  await c.waitForSelector('.dm-user [aria-label="Pinned"]');
  check(true, 'pinned from the sheet');

  await hold(c.locator('.rail-guild[aria-label="Alpha"]'));
  await c.waitForSelector('.context-sheet');
  const phoneRail = await items(c, '.context-sheet');
  check(phoneRail.includes('Leave Guild') && !phoneRail.includes('Guild Settings'), `holding a guild icon: ${phoneRail.join(', ')}`);
  await shot(c, 'phone-rail-sheet');
  await closeSheet();
  // Hold and move still drags Beta above Alpha.
  const railOrder = () => c.$$eval('.rail-guild', (els) => els.map((e) => e.getAttribute('aria-label')));
  const alphaBox = await c.locator('.rail-guild[aria-label="Alpha"]').boundingBox();
  const betaBox = await c.locator('.rail-guild[aria-label="Beta"]').boundingBox();
  await hold(c.locator('.rail-guild[aria-label="Beta"]'), { moveBy: alphaBox.y - betaBox.y - 10 });
  await c.waitForFunction(() => document.querySelector('.rail-guild')?.getAttribute('aria-label') === 'Beta', null, { timeout: 5000 });
  check(!(await c.$('.context-sheet')) && (await railOrder())[0] === 'Beta', 'holding then moving a guild still drags it');

  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {});
  await c.waitForTimeout(400);
  const phoneList = await c.locator('.guild-channel-list').boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const at = { x: phoneList.x + phoneList.width / 2, y: phoneList.y + phoneList.height - 30 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await c.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.context-sheet');
  check(same(await items(c, '.context-sheet'), ['Invite People']), "holding the channel list's empty space: Invite People (a member)");
  await closeSheet();

  console.log('menus: ok');
} catch (err) {
  console.error('menus: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
