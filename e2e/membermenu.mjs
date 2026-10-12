// A guild member's card and right-click menu: the card has no buttons; + opens the roles to add
// with the search box focused (type at once, Enter adds the first match); right-clicking a member
// list row gives the same menu as their message's picture and name (Message, Add Friend, Make
// Owner, Kick, Ban, Block, Report, Copy User ID); Kick asks first and works; Message opens the DM.
// Phone: holding a member row or a message's author opens the menu as a sheet, holding the
// message's text still its actions.
//   node e2e/serve.mjs &   then   node e2e/membermenu.mjs [screenshot dir]
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
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const menuItems = (page, selector = '.context-menu') => page.$$eval(`${selector} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;

  const guild = await api(a, 'POST', '/guilds', { name: 'Menus' });
  const general = guild.channels[0];
  for (const name of ['Moderators', 'Regulars', 'Readers']) await api(a, 'POST', `/guilds/${guild.id}/roles`, { name });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);
  await api(bob.page, 'POST', `/channels/${general.id}/messages`, { content: 'hello from bob' });

  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('text=hello from bob');
  const bobRow = a.locator(`.member-row:has-text("${bob.name}")`);

  // The card floats over the chat, left of the list at the row's height; no row moves.
  const rowTops = () => a.$$eval('.member-row', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const topsBefore = await rowTops();
  await bobRow.click();
  const card = a.locator('.member-card');
  await card.waitFor();
  await a.waitForFunction(() => getComputedStyle(document.querySelector('.member-card')).visibility === 'visible');
  const cardBox = await card.boundingBox();
  const listBox = await a.locator('.member-list').boundingBox();
  const rowBox = await bobRow.boundingBox();
  check(cardBox.x + cardBox.width <= listBox.x && cardBox.x > 0, `the card is left of the member list (card ${Math.round(cardBox.x)}-${Math.round(cardBox.x + cardBox.width)}, list from ${Math.round(listBox.x)})`);
  check(Math.abs(cardBox.y - rowBox.y) < 2 && cardBox.width > listBox.width, `at Bob's row's height, wider than the list (${Math.round(cardBox.width)} px)`);
  check(JSON.stringify(await rowTops()) === JSON.stringify(topsBefore), "the other members didn't move");
  await shot(a, 'member-card');

  // No buttons on it but the roles' +.
  const buttons = await card.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent.trim()));
  check(JSON.stringify(buttons) === '["Add role"]', `the card has no action buttons: ${buttons.join(', ')}`);

  // + opens the roles to add with the search box focused: typing filters, Enter adds the first.
  await card.locator('button[aria-label="Add role"]').click();
  check(await a.evaluate(() => document.activeElement?.matches('.role-picker-search')), 'the search box has the focus');
  const listed = () => card.locator('.role-picker li button').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  check((await listed()).length === 3, `every role to add listed: ${(await listed()).join(', ')}`);
  await a.keyboard.type('reg');
  check(JSON.stringify(await listed()) === '["Regulars"]', 'typing straight away filters to Regulars');
  await shot(a, 'role-search');
  await a.keyboard.press('Enter');
  await card.locator('.role-chip:has-text("Regulars")').waitFor();
  check(!(await card.locator('.role-picker').count()), 'Enter gave Bob Regulars and closed the list');
  await card.locator('button[aria-label="Add role"]').click();
  await a.keyboard.type('zzz');
  check(await card.locator('.role-picker-empty').isVisible(), 'no match says so');
  await a.keyboard.press('Escape');
  check(!(await card.locator('.role-picker').count()), 'Escape closes the list');
  await a.click('.channel-header-name');

  // His name on a message opens the same card: roles, + and all, as wide.
  await a.locator(`.message-author:has-text("${bob.name}")`).first().click();
  const fromName = a.locator('.profile-popover');
  await fromName.waitFor();
  check(await fromName.locator('.role-chip:has-text("Regulars")').count() === 1 && await fromName.locator('button[aria-label="Add role"]').count() === 1, "his name opens the member card (Regulars, +)");
  check(Math.round((await fromName.boundingBox()).width) === 340, 'as wide as the list\'s');
  await fromName.locator('button[aria-label="Add role"]').click();
  await fromName.locator('.role-picker').waitFor();
  await shot(a, 'name-card');
  await a.keyboard.press('Escape');
  await a.keyboard.press('Escape');
  await fromName.waitFor({ state: 'detached' });
  check(true, 'Escape closes the picker, then the card');

  // The member row's right-click menu = the message's picture's = the name's.
  await bobRow.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  const fromRow = await menuItems(a);
  await shot(a, 'row-menu');
  await a.keyboard.press('Escape');
  check(JSON.stringify(fromRow) === '["Message","Add Friend","Make Owner","Kick","Ban","Block","Report","Copy User ID"]', `the row's menu: ${fromRow.join(', ')}`);
  for (const selector of [`.message-avatar[data-user-id="${bob.id}"]`, `.message-author:has-text("${bob.name}")`]) {
    await a.locator(selector).first().click({ button: 'right' });
    await a.waitForSelector('.context-menu');
    const items = await menuItems(a);
    await a.keyboard.press('Escape');
    await a.waitForSelector('.context-menu', { state: 'detached' });
    check(JSON.stringify(items) === JSON.stringify(fromRow), `the same from ${selector.startsWith('.message-avatar') ? 'his picture' : 'his name'} on a message`);
  }
  // Yourself: only Copy User ID.
  await a.locator(`.member-row:has-text("${alice.name}")`).click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  check(JSON.stringify(await menuItems(a)) === '["Copy User ID"]', 'on yourself only Copy User ID');
  await a.keyboard.press('Escape');

  // Message opens the DM.
  await bobRow.click({ button: 'right' });
  await a.click('.context-menu >> text=Message');
  await a.waitForURL(`${BASE}/dm/${bob.id}`);
  check(true, 'Message opens the DM');

  // Kick asks first, then he's gone from the list.
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector(`.member-row:has-text("${carol.name}")`);
  // (Carol stays for the phone; kick Bob.)
  await a.locator(`.member-row:has-text("${bob.name}")`).click({ button: 'right' });
  await a.click('.context-menu >> text=Kick');
  await a.waitForSelector('.vc-dialog');
  await shot(a, 'kick-dialog');
  await a.click('.vc-dialog button:has-text("Kick")');
  await a.waitForSelector(`.member-row:has-text("${bob.name}")`, { state: 'detached' });
  check(true, 'Kick asked first, then Bob left the member list');

  // Phone: holding a member row opens the sheet; holding an author too; the text keeps its actions.
  const c = carol.page;
  const cdp = await c.context().newCDPSession(c);
  const hold = async (locator) => {
    const box = await locator.boundingBox();
    const point = { x: box.x + Math.min(box.width / 2, 20), y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await c.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const closeSheet = async () => {
    await c.tap('.action-sheet-backdrop', { position: { x: 20, y: 20 } });
    await c.waitForSelector('.action-sheet', { state: 'detached' });
  };
  await api(a, 'POST', `/channels/${general.id}/messages`, { content: 'hello from alice' });
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('text=hello from alice');
  await hold(c.locator(`.message-author:has-text("${alice.name}")`).last());
  await c.waitForSelector('.context-sheet');
  const sheet = await menuItems(c, '.context-sheet');
  await shot(c, 'phone-author-sheet');
  check(sheet[0] === 'Message' && sheet.includes('Copy User ID') && !sheet.includes('Kick'), `holding an author: the person's sheet (${sheet.join(', ')})`);
  await closeSheet();
  await hold(c.locator('.dm-message-content:has-text("hello from alice")').last());
  await c.waitForSelector('.action-sheet');
  check(!(await c.$('.context-sheet')), "holding the message's text still opens its actions");
  await closeSheet();
  await c.click('button[aria-label="Show member list"]');
  const aliceRow = c.locator(`.member-row:has-text("${alice.name}")`);
  await aliceRow.waitFor();
  await hold(aliceRow);
  await c.waitForSelector('.context-sheet');
  check(JSON.stringify(await menuItems(c, '.context-sheet')) === JSON.stringify(sheet), 'holding her member row: the same sheet');
  await shot(c, 'phone-row-sheet');
  check(!(await c.$('.member-card')), "and the hold didn't open her card");
  await closeSheet();
  // A tap opens it below the row, over the full-screen list, within the screen.
  await aliceRow.tap();
  await c.locator('.member-card').waitFor();
  await c.waitForFunction(() => getComputedStyle(document.querySelector('.member-card')).visibility === 'visible');
  const phoneCard = await c.locator('.member-card').boundingBox();
  const phoneRow = await aliceRow.boundingBox();
  const width = c.viewportSize().width;
  check(phoneCard.x >= 0 && phoneCard.x + phoneCard.width <= width && phoneCard.y >= phoneRow.y + phoneRow.height, `phone: the card is below her row, on screen (${Math.round(phoneCard.x)}-${Math.round(phoneCard.x + phoneCard.width)} of ${width})`);
  await shot(c, 'phone-member-card');

  console.log('membermenu: all good');
} finally {
  await browser.close();
}
