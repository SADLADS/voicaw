// Roles and private channels in a real browser: the owner makes a coloured, separately shown
// role in Server Settings, gives it to Bob from the member list, and makes a private channel
// only that role can see; Carol (no role) never sees it. Then channel permissions.
//   node e2e/serve.mjs &   then   node e2e/roles.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function sendInChannel(page, text) {
  await page.click('#dm-input');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;

  await a.click('button[aria-label="Add a server"]');
  await a.fill('#new-guild-name', 'Role Play');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);
  await sendInChannel(b, 'hello from bob');
  await a.waitForSelector('.dm-message-content:has-text("hello from bob")');

  // Server Settings → Roles → Create Role: "Mods", pink, shown separately, Manage Messages.
  await a.click('.guild-header-button');
  await a.click('text=Server Settings');
  await a.click('.settings-tab:has-text("Roles")');
  await a.click('button:has-text("Create Role")');
  await a.waitForSelector('.roles-list-item:has-text("new role")');
  await a.fill('#role-name', 'Mods');
  await a.click('button[aria-label="#e91e63"]');
  await a.check('text=Display role members separately');
  await a.check('.role-toggle:has-text("Manage Messages") input');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('.roles-list-item:has-text("Mods")');
  // A second role, to see ordering.
  await a.click('button:has-text("Create Role")');
  await a.waitForSelector('.roles-list-item:has-text("new role")');
  await a.fill('#role-name', 'Regulars');
  await a.click('button[aria-label="#3498db"]');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('.roles-list-item:has-text("Regulars") .role-dot');
  // New roles go in at the bottom (above @everyone). Move Regulars up, then back down.
  const order = async () => a.$$eval('.roles-list-name', (els) => els.map((e) => e.textContent).join(', '));
  console.log('roles:', await order());
  await a.click('.roles-list-select:has-text("Regulars")');
  await a.click('button[aria-label="Move Regulars up"]');
  await a.waitForFunction(() => document.querySelector('.roles-list-name')?.textContent === 'Regulars');
  console.log('after moving Regulars up:', await order());
  await a.click('button[aria-label="Move Regulars down"]');
  await a.waitForFunction(() => document.querySelector('.roles-list-name')?.textContent === 'Mods');
  console.log('and back down:', await order());
  // Drag and drop: Regulars onto Mods puts it on top.
  await a.locator('.roles-list-item:has-text("Regulars")').dragTo(a.locator('.roles-list-item:has-text("Mods")'));
  await a.waitForFunction(() => document.querySelector('.roles-list-name')?.textContent === 'Regulars');
  console.log('after dragging Regulars onto Mods:', await order());
  await a.locator('.roles-list-item:has-text("Mods")').dragTo(a.locator('.roles-list-item:has-text("Regulars")'));
  await a.waitForFunction(() => document.querySelector('.roles-list-name')?.textContent === 'Mods');
  console.log('dragged back:', await order());
  await shot(a, 'roles-settings');
  await a.keyboard.press('Escape');

  // Give Bob "Mods" from the member list.
  await a.click(`.member-row:has-text("${bob.name}")`);
  await a.click('.member-card button[aria-label="Add role"]');
  await a.click('.role-picker button:has-text("Mods")');
  await a.waitForSelector('.member-group:has-text("Mods — 1")');
  const bobColor = await a.$eval(`.member-row:has-text("${bob.name}") .member-name`, (el) => getComputedStyle(el).color);
  const chatColor = await a.$eval('.each-dm-message-wrapper:has-text("hello from bob") .message-author', (el) => getComputedStyle(el).color);
  console.log('bob in member list:', bobColor, '| in chat:', chatColor);
  if (bobColor !== 'rgb(233, 30, 99)' || chatColor !== 'rgb(233, 30, 99)') throw new Error('role colour not applied');
  const defaultColor = await a.$eval(`.member-row:has-text("${carol.name}") .member-name`, (el) => getComputedStyle(el).color);
  console.log('carol (no role):', defaultColor);
  await shot(a, 'member-list-roles');
  // Bob can now delete Carol's messages (Manage Messages).
  await sendInChannel(c, 'carol was here');
  await b.hover('.each-dm-message-wrapper:has-text("carol was here")');
  await b.waitForSelector('.each-dm-message-wrapper:has-text("carol was here") .trash-button');
  console.log('bob (Mods) gets a delete button on carol\'s message');
  await a.click('.channel-header-name');

  // A private channel for Mods.
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.fill('#channel-name', 'mod-chat');
  await a.check('.private-toggle input');
  await a.check('.private-roles label:has-text("Mods") input');
  await shot(a, 'create-private-channel');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.guild-channel.active:has-text("mod-chat") .channel-icon-lock');
  await b.waitForSelector('.guild-channel:has-text("mod-chat")');
  await sendInChannel(a, 'mods only');
  await c.waitForTimeout(1000);
  if (await c.$('.guild-channel:has-text("mod-chat")')) throw new Error('carol can see the private channel');
  console.log('private channel: bob sees it, carol does not');
  await shot(a, 'private-channel');

  // Channel permissions: nobody but Mods may post in #general.
  await a.hover('.guild-channel:has-text("general")');
  await a.click('button[aria-label="Edit general"]');
  await a.click('.settings-tab:has-text("Permissions")');
  await a.waitForSelector('.override-grid');
  await a.click('button[aria-label="Deny Send Messages"]');
  await a.waitForSelector('button[aria-label="Deny Send Messages"][aria-checked="true"]');
  await a.selectOption('select[aria-label="Add a role or member"]', { label: 'Mods' });
  await a.click('button[aria-label="Allow Send Messages"]');
  await a.waitForSelector('button[aria-label="Allow Send Messages"][aria-checked="true"]');
  await shot(a, 'channel-permissions');
  await a.click('button:has-text("Done")');

  await c.click('.guild-channel-link:has-text("general")');
  await c.waitForSelector('.composer-locked');
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector('#dm-input');
  console.log('#general: carol read-only, bob can post');
  await shot(c, 'read-only-channel');

  // The roles editor on a phone-sized screen.
  await a.setViewportSize({ width: 400, height: 820 });
  await a.click('.guild-header-button');
  await a.click('text=Server Settings');
  await a.click('.settings-tab:has-text("Roles")');
  await a.waitForSelector('.role-editor');
  await shot(a, 'roles-settings-narrow');

  console.log('roles e2e: ok');
} catch (err) {
  console.error('roles e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
