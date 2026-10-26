// Global admins' items in a person's menu (utils/personMenu.js, SafetyDialogs): right-clicking a
// row on the Friends page (Everyone, All) or the DM list gives an admin Make Admin and Suspend
// Account; Suspend asks with a reason and logs them out (the login page says why), then the
// menu has Lift Suspension (they can log in again); Make Admin asks, then the menu has Remove
// Admin and no Suspend; a non-admin's menu has none of it; phone: holding a row opens the sheet.
//   node e2e/serve.mjs &   then   node e2e/adminmenu.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { join } from 'path';
import { BASE, devices, launchChrome, makeFriends, signUp } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: join(dir, `${name}.png`) }) : null);
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const row = (page, name) => page.locator('.friends-row', { hasText: name });
const menuItems = (page) => page.locator('[role="menu"] [role^="menuitem"]').allTextContents();
async function menuOf(page, name) {
  await row(page, name).click({ button: 'right' });
  await page.waitForSelector('[role="menu"]');
  return menuItems(page);
}
const closeMenu = (page) => page.keyboard.press('Escape');

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await makeFriends(admin, alice);
  const p = admin.page;

  // Everyone tab: Make Admin and Suspend Account, between the friend items and Block / Report.
  await p.goto(`${BASE}/dm/friends`);
  await p.click('.friends-tab:has-text("Everyone")');
  await row(p, bob.name).waitFor();
  let items = await menuOf(p, bob.name);
  check(items.some((i) => i.includes('Make Admin')) && items.some((i) => i.includes('Suspend Account')), `Everyone row menu has the admin items: ${items.join(' | ')}`);
  check(items.some((i) => i.includes('Report')), 'and still Block / Report');
  await shot(p, 'everyone-menu');

  // Suspend asks, with a reason; bob's open app is logged out and told why.
  await p.click('[role="menu"] [role^="menuitem"]:has-text("Suspend Account")');
  await p.waitForSelector('.vc-dialog textarea');
  await p.fill('.vc-dialog textarea', 'Spamming everyone');
  await shot(p, 'suspend-dialog');
  await p.click('.vc-dialog .btn-danger');
  await p.waitForSelector('.vc-dialog', { state: 'detached' });
  check(await bob.page.waitForSelector('text=Spamming everyone', { timeout: 10000 }).then(() => true, () => false), "bob's app is logged out with the reason");
  await shot(bob.page, 'bob-suspended');

  // Then Lift Suspension (no asking), and bob logs in again.
  items = await menuOf(p, bob.name);
  check(items.some((i) => i.includes('Lift Suspension')) && !items.some((i) => i.includes('Make Admin')), `suspended: only Lift Suspension of the admin items: ${items.join(' | ')}`);
  await p.click('[role="menu"] [role^="menuitem"]:has-text("Lift Suspension")');
  await p.waitForSelector('[role="menu"]', { state: 'detached' });
  items = await menuOf(p, bob.name);
  check(items.some((i) => i.includes('Suspend Account')), 'lifted: Suspend Account again');
  await closeMenu(p);

  // Make Admin on a friend from the All tab: asks, then Remove Admin and no Suspend.
  await p.click('.friends-tab:has-text("All")');
  await row(p, alice.name).waitFor();
  await menuOf(p, alice.name);
  await p.click('[role="menu"] [role^="menuitem"]:has-text("Make Admin")');
  await p.waitForSelector('.vc-dialog');
  await p.click('.vc-dialog .btn-danger');
  await p.waitForSelector('.vc-dialog', { state: 'detached' });
  items = await menuOf(p, alice.name);
  check(items.some((i) => i.includes('Remove Admin')) && !items.some((i) => i.includes('Suspend Account')), `admin: Remove Admin, no Suspend: ${items.join(' | ')}`);
  await closeMenu(p);

  // The DM list's menu has them too.
  await p.click(`.dm-user-list-container .dm-user:has-text("${alice.name}")`, { button: 'right' });
  await p.waitForSelector('[role="menu"]');
  items = await menuItems(p);
  check(items.some((i) => i.includes('Remove Admin')), `DM list menu has the admin item: ${items.join(' | ')}`);
  await closeMenu(p);

  // A non-admin (bob, logged in again) gets the person menu on a Friends row, without them.
  await bob.page.goto(`${BASE}/`);
  await bob.page.fill('input[placeholder="Username"]', bob.name);
  await bob.page.fill('input[placeholder="Password"]', bob.password);
  await bob.page.click('button:has-text("Login")');
  check(await bob.page.waitForSelector('#dm-main', { timeout: 20000 }).then(() => true, () => false), 'bob logs in again once lifted');
  await makeFriends(bob, alice);
  await bob.page.goto(`${BASE}/dm/friends`);
  await bob.page.click('.friends-tab:has-text("All")');
  await row(bob.page, alice.name).waitFor();
  items = await menuOf(bob.page, alice.name);
  check(items.some((i) => i.includes('Remove Friend')) && !items.some((i) => /Admin|Suspend/.test(i)), `non-admin's menu: ${items.join(' | ')}`);
  await closeMenu(bob.page);

  // Phone (another admin): holding a row opens the person's sheet.
  const other = await signUp(browser, 'adminphone', { ...devices['Pixel 7'] });
  const phone = other.page;
  await phone.goto(`${BASE}/dm/friends`);
  await phone.click('.friends-tab:has-text("Everyone")');
  await row(phone, bob.name).waitFor();
  const box = await row(phone, bob.name).boundingBox();
  const cdp = await phone.context().newCDPSession(phone);
  const point = { x: box.x + 30, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await phone.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const sheet = await phone.waitForSelector('[role="menu"]', { timeout: 5000 }).then(() => true, () => false);
  items = sheet ? await menuItems(phone) : [];
  check(items.some((i) => i.includes('Suspend Account')), `phone: holding a row opens the sheet: ${items.join(' | ')}`);
  check(!phone.url().includes(`/dm/${bob.id}`), "the hold didn't also open the DM");
  await shot(phone, 'phone-sheet');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
