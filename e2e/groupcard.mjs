// A group DM member's profile card: clicking someone in the members panel opens their card over
// the chat, left of the panel at their row's height (the rows don't move), only the profile;
// Escape and a click elsewhere close it; right-clicking a member gives the person's menu. A name
// in the chat opens the same card.
// Phone: a member or a name opens the full profile instead (no card).
//   node e2e/serve.mjs &   then   node e2e/groupcard.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, devices, BASE, makeFriends, send } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const showMembers = async (page) => {
  if (!(await page.$('.group-members'))) await page.click('.group-members-button');
  await page.waitForSelector('.group-member-open');
};
// Shown, and its entrance (a fade and a 4px rise, dms.css .profile-popover) finished, so it's
// where it rests.
const visible = async (page) => {
  await page.waitForFunction(() => {
    const card = document.querySelector('.member-card');
    return card && getComputedStyle(card).visibility === 'visible';
  });
  await page.evaluate(() => {
    const card = document.querySelector('.member-card');
    return Promise.all(card.closest('.profile-popover, .member-card').getAnimations({ subtree: true }).map((x) => x.finished));
  });
};

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const [a, d] = [ann.page, dan.page];
  await makeFriends(ann, bea, dan);

  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Cards');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${dan.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupPath = new URL(a.url()).pathname;
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await showMembers(a);

  const rowTops = () => a.$$eval('.group-member', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const topsBefore = await rowTops();
  const beaRow = a.locator(`.group-member-open:has-text("${bea.name}")`);
  await beaRow.click();
  await visible(a);
  const card = a.locator('.member-card');
  const cardBox = await card.boundingBox();
  const listBox = await a.locator('.group-members').boundingBox();
  const rowBox = await beaRow.boundingBox();
  check(cardBox.x + cardBox.width <= listBox.x && cardBox.x > 0, `the card is left of the members panel (card ${Math.round(cardBox.x)}-${Math.round(cardBox.x + cardBox.width)}, panel from ${Math.round(listBox.x)})`);
  check(Math.abs(cardBox.y - rowBox.y) < 2 && Math.round(cardBox.width) === 340, `at Bea's row's height, 340 px wide (${Math.round(cardBox.width)})`);
  check(JSON.stringify(await rowTops()) === JSON.stringify(topsBefore), "the other members didn't move");
  check((await card.locator('.profile-card-name').textContent()).includes(bea.name), "it's Bea's profile");
  check(!(await card.locator('.member-card-roles, button:not(.profile-card-open)').count()), 'only the profile: no roles, no buttons (but the picture and names, which open the profile)');
  await shot(a, 'group-card');
  await a.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
  check(true, 'Escape closes it');
  await beaRow.click();
  await visible(a);
  await a.click('.group-dm-title');
  await card.waitFor({ state: 'detached' });
  check(true, 'a click elsewhere closes it');
  await beaRow.click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  const items = await a.$$eval('.context-menu [role^="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));
  check(items.includes('Copy User ID'), `right-clicking her gives the person's menu (${items.join(', ')})`);
  await a.keyboard.press('Escape');

  // A name in the chat: the same card, the profile only.
  await send(a, 'hello cards');
  await a.locator(`.message-author:has-text("${ann.name}")`).first().click();
  const fromName = a.locator('.profile-popover');
  await fromName.waitFor();
  check(Math.round((await fromName.boundingBox()).width) === 340 && !(await fromName.locator('.member-card-roles, button:not(.profile-card-open)').count()), 'a name in the chat opens the same 340 px card, profile only');
  await shot(a, 'group-name-card');
  await a.keyboard.press('Escape');
  await fromName.waitFor({ state: 'detached' });

  // Phone: a tap skips the card, straight to the full profile (full screen); a name too.
  await d.goto(`${BASE}${groupPath}`);
  await d.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await showMembers(d);
  await d.locator(`.group-member-open:has-text("${ann.name}")`).tap();
  await d.locator('.user-profile.sheet').waitFor();
  check(!(await d.$('.member-card')), "phone: a tap opens Ann's full profile, no card");
  await d.locator('.user-profile-handle').tap();
  await d.locator('.user-profile').waitFor({ state: 'detached' });
  if (await d.$('.group-members')) await d.click('.group-members-header button[aria-label="Close"]');
  await d.locator(`.message-author:has-text("${ann.name}")`).first().tap();
  await d.locator('.user-profile.sheet').waitFor();
  check(!(await d.$('.profile-popover')), 'phone: a name in the chat opens the full profile, no card');
  await shot(d, 'group-profile-phone');

  console.log('groupcard: all good');
} finally {
  await browser.close();
}
