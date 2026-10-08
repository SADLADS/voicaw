// Copy … ID in right-click menus, giving the ids bots know things by: a channel, a category
// (offset by 2^40, as in the bot API), a guild on the rail; a person from a message's author
// and avatar, a mention, the member list and the DM list (the message's own menu stays
// everywhere else on it). On a phone, holding a conversation's row has it in the sheet.
//   node e2e/serve.mjs &   then   node e2e/copyids.mjs [screenshot dir]
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
const items = (page) => page.$$eval('.context-menu [role^="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Alpha' });
  const general = guild.channels[0];
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);

  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const clipboard = () => a.evaluate(() => navigator.clipboard.readText());
  // Right-clicks `selector`, picks `label`, and returns what was copied.
  const copyFrom = async (selector, label) => {
    await a.locator(selector).first().click({ button: 'right' });
    await a.waitForSelector('.context-menu');
    const menu = await items(a);
    const clicked = Date.now();
    await a.click(`.context-menu >> text=${label}`);
    await a.waitForSelector('.context-menu', { state: 'detached' });
    const closedIn = Date.now() - clicked;
    check(closedIn < 400, `${label} closes the menu at once (${closedIn} ms)`);
    return { menu, copied: await clipboard() };
  };

  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');

  let r = await copyFrom(`.guild-channel-link:has-text("${general.name}")`, 'Copy Channel ID');
  check(r.copied === String(general.id), `Copy Channel ID: ${r.copied}`);
  r = await copyFrom('.guild-category-toggle', 'Copy Category ID');
  check(r.copied === String(2 ** 40 + general.category_id), `Copy Category ID gives the bot API's: ${r.copied}`);
  r = await copyFrom('.rail-guild[aria-label="Alpha"]', 'Copy Guild ID');
  check(r.copied === String(guild.id), `Copy Guild ID: ${r.copied}`);

  // People in the channel.
  await api(bob.page, 'POST', `/channels/${general.id}/messages`, { content: `hello <@${alice.id}>` });
  await a.waitForSelector('.message-author');
  r = await copyFrom(`.message-author:has-text("${bob.name}")`, 'Copy User ID');
  check(JSON.stringify(r.menu) === '["Message","Add Friend","Make Owner","Kick","Ban","Block","Report","Copy User ID"]', `a message's author gets the person's menu: ${r.menu}`);
  check(r.copied === String(bob.id), `and copies their id: ${r.copied}`);
  r = await copyFrom(`.message-avatar[data-user-id="${bob.id}"]`, 'Copy User ID');
  check(r.copied === String(bob.id), 'so does their picture');
  await a.locator('.dm-message-content .mention').first().click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  await shot(a, 'mention-menu');
  check(!(await items(a)).includes('Block'), 'no Block or Report on yourself');
  await a.click('.context-menu >> text=Copy User ID');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check(await clipboard() === String(alice.id), 'a mention copies the mentioned person');
  await a.locator('.dm-message-content p').first().click({ button: 'right', position: { x: 2, y: 4 } });
  await a.waitForSelector('.context-menu');
  check(!(await items(a)).includes('Copy User ID') && (await items(a)).includes('Copy Text'), "the rest of the message keeps the message's own menu");
  await a.keyboard.press('Escape');
  r = await copyFrom(`.member-list .member-row:has-text("${bob.name}")`, 'Copy User ID');
  check(r.copied === String(bob.id), 'a member list row copies the member');

  // The DM list.
  await api(bob.page, 'POST', '/dm-send', { recipient_id: alice.id, content: 'hi' });
  await a.goto(`${BASE}/dm`);
  await a.waitForSelector('.dm-user-list-container .dm-user');
  r = await copyFrom(`.dm-user-list-container .dm-user:has-text("${bob.name}")`, 'Copy User ID');
  check(r.menu.at(-1) === 'Copy User ID', `the DM list's menu ends with Copy User ID: ${r.menu.join(', ')}`);
  check(r.copied === String(bob.id), 'and copies them');

  // You, at the bottom: no right-click menu (ours or the browser's); the click menu has it.
  await a.evaluate(() => {
    window.__menuBlocked = [];
    window.addEventListener('contextmenu', (e) => window.__menuBlocked.push(e.defaultPrevented));
  });
  for (const part of ['.user-panel-avatar img', '.user-panel-name']) {
    await a.locator(part).click({ button: 'right' });
  }
  await a.waitForTimeout(300);
  check(!(await a.$('.context-menu')), 'right-clicking your picture or name in the user panel opens no menu');
  check(JSON.stringify(await a.evaluate(() => window.__menuBlocked)) === '[true,true]', "nor the browser's");
  await a.click('.user-panel-me');
  await a.waitForSelector('.user-menu');
  await a.locator('.user-menu-avatar img').click({ button: 'right' });
  await a.waitForTimeout(300);
  check(!(await a.$('.context-menu')) && await a.evaluate(() => window.__menuBlocked.at(-1)), 'nor does the open menu');
  check(JSON.stringify(await a.$$eval('.user-menu-item', (els) => els.map((e) => e.textContent.trim()))) === '["Edit Profile","Copy User ID","Log out"]', 'the user panel menu: Edit Profile, Copy User ID, Log out');
  await shot(a, 'user-menu');
  await a.click('.user-menu-item:has-text("Copy User ID")');
  await a.waitForSelector('.user-menu', { state: 'detached', timeout: 400 });
  check(await clipboard() === String(alice.id), 'and copies your id, closing at once');

  // Phone: hold a conversation; the sheet has it too.
  const c = carol.page;
  await api(c, 'POST', '/dm-send', { recipient_id: alice.id, content: 'hey' });
  await c.goto(`${BASE}/dm/${alice.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {});
  await c.waitForTimeout(400);
  const row = c.locator('.dm-user-list-container .dm-user').first();
  await row.waitFor();
  const cdp = await c.context().newCDPSession(c);
  const box = await row.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await c.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.context-sheet >> text=Copy User ID');
  await c.waitForTimeout(300);
  await shot(c, 'phone-dm-sheet');
  check(true, 'holding a conversation on a phone: Copy User ID in the sheet');

  console.log('copy ids: all good');
} finally {
  await browser.close();
}
