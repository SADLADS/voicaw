// Settings: a page per category (/settings/<page>#<subsection>). Computer: the column beside
// the rail lists the pages, the open one's subsections under it (click = scrolled to it), the
// page header lines up with the column's, search lists subsections across pages, old
// /settings#<id> links land on the right page, admins get Admin and Reports, Log Out asks,
// Developer Portal opens the portal. Phone: the column is the list pane, a page slides over it
// (swipe or Back returns to the list, Back again leaves Settings), no subsections listed,
// Edit Profile opens your full profile over it, /settings alone opens on the list, a page loaded on its own has
// the list behind it, nothing wider than the screen. Light and dark screenshots.
//   node e2e/serve.mjs &   then   node e2e/settings.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const where = (page) => page.evaluate(() => location.pathname + location.hash);
const texts = (page, selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));
const navItems = (page) => texts(page, '.settings-nav .settings-nav-item');
const navSubs = (page) => texts(page, '.settings-nav .settings-nav-sub');
const title = (page) => page.$eval('.settings-page-title', (e) => e.textContent).catch(() => null);
const navButton = (page, name) => page.locator('.settings-nav').getByRole('button', { name, exact: true });
// Whether the page's content is scrolled to `selector`: it's at the top, or as near as it
// gets (the content scrolled to its end).
const scrolledTo = (page, selector) => page.evaluate((s) => {
  const content = document.querySelector('.settings-content');
  const top = Math.round(document.querySelector(s).getBoundingClientRect().top - content.getBoundingClientRect().top);
  const atEnd = content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 1;
  return { ok: (top >= 0 && top < 30) || (atEnd && top > 0), top };
}, selector);
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

const pane = (page) => page.evaluate(() => {
  const w = document.querySelector('.main-wrapper');
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'none';
});
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });
  await page.waitForTimeout(150);
};
const back = async (page) => {
  await page.evaluate(() => history.back());
  await page.waitForTimeout(300);
  await settle(page);
};
async function swipeRight(page) {
  const { width, height } = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', 30, height * 0.6);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', 30 + (width * 0.7 * i) / 10, height * 0.6);
    await new Promise((r) => setTimeout(r, 16));
  }
  await touch('touchEnd');
  await cdp.detach();
  await settle(page);
}

const browser = await launchChrome();
try {
  // A computer, as an admin.
  const admin = await signUp(browser, 'admin');
  const page = admin.page;
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('.settings-page-title');
  await page.waitForFunction(() => [...document.querySelectorAll('.settings-nav-item')].some((e) => e.textContent === 'Admin'));
  check(await title(page) === 'My Account', 'opens on My Account');
  check(JSON.stringify(await texts(page, '.settings-nav-category')) === JSON.stringify(['User Settings', 'App Settings', 'Admin']), 'groups: User Settings, App Settings, Admin');
  const items = await navItems(page);
  check(JSON.stringify(items.slice(-3)) === JSON.stringify(['About', 'Developer Portal', 'Log Out']), `ends with About, Developer Portal, Log Out (${items.join(', ')})`);
  check(!(await page.getByText(/bot api docs/i).count()), 'no Bot API docs button');
  check(JSON.stringify(await navSubs(page)) === JSON.stringify(['Password', 'Recovery code', 'Two-factor authentication', 'Devices', 'Delete account']), 'My Account\'s subsections under it');
  const lines = await page.evaluate(() => [document.querySelector('.settings-header'), document.querySelector('.settings-page-header')]
    .map((e) => Math.round(e.getBoundingClientRect().bottom)));
  check(lines[0] === lines[1], `the column's header and the page's line up (${lines})`);
  await shot(page, '1-desktop-account');

  await navButton(page, 'Voice & Video').click();
  await page.waitForFunction(() => document.querySelector('.settings-page-title')?.textContent === 'Voice & Video');
  check(await where(page) === '/settings/voice-video', 'Voice & Video is its own page');
  const subs = await navSubs(page);
  check(subs.includes('Camera') && !subs.includes('Password'), `only its subsections listed (${subs.join(', ')})`);
  check(!(await page.locator('.settings-content').getByPlaceholder('Current password').count()), 'other pages\' settings not on it');
  await navButton(page, 'Mic test').click();
  await page.waitForTimeout(300);
  const processing = await scrolledTo(page, '#settings-mic-test');
  check(processing.ok && processing.top < 30, `Mic test scrolls to the top (${processing.top}px)`);
  await navButton(page, 'Camera').click();
  await page.waitForTimeout(300);
  const cam = await scrolledTo(page, '#settings-camera');
  check(cam.ok, `Camera scrolls to its part of the page (${cam.top}px from the top)`);
  check(await where(page) === '/settings/voice-video#camera', 'and is in the URL');
  await shot(page, '2-desktop-voice-camera');

  // Search.
  await page.fill('.settings-search input', 'webcam');
  check(JSON.stringify(await texts(page, '.settings-nav-result-title')) === JSON.stringify(['Camera']), 'search "webcam" finds Camera');
  await page.fill('.settings-search input', 'blocked');
  await shot(page, '3-desktop-search');
  await page.locator('.settings-nav-result').first().click();
  await page.waitForFunction(() => location.pathname === '/settings/privacy');
  check(await where(page) === '/settings/privacy#blocked', 'a result opens its page at it');
  await page.fill('.settings-search input', '');

  // Admin's parts.
  await navButton(page, 'Admin').click();
  await page.waitForSelector('#settings-admin-storage');
  await navButton(page, 'Storage').click();
  await page.waitForTimeout(300);
  const storage = await scrolledTo(page, '#settings-admin-storage');
  check(storage.ok, `Admin → Storage scrolls to it (${storage.top}px)`);
  check((await navItems(page)).includes('Reports'), 'Reports listed for admins');
  await shot(page, '4-desktop-admin');

  // Old links.
  await page.goto(`${BASE}/settings#devices`);
  await page.waitForFunction(() => location.pathname === '/settings/account');
  check(await where(page) === '/settings/account#devices', 'old /settings#devices lands on My Account → Devices');
  await page.goto(`${BASE}/settings#sounds`);
  await page.waitForFunction(() => location.pathname === '/settings/notifications');
  check(await where(page) === '/settings/notifications#sounds', 'old /settings#sounds on Notifications → Sounds');

  // Log Out asks; Cancel keeps you in.
  await navButton(page, 'Log Out').click();
  await page.waitForSelector('text=Are you sure you want to log out?');
  await shot(page, '5-desktop-logout');
  await page.getByRole('button', { name: 'Cancel' }).click();
  check(await page.locator('text=Are you sure you want to log out?').count() === 0 && (await where(page)).startsWith('/settings'), 'Log Out asks first, Cancel stays');

  await navButton(page, 'Developer Portal').click();
  await page.waitForURL('**/developers');
  check(true, 'Developer Portal opens the portal');

  // Dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/settings/appearance`);
  await page.waitForSelector('.settings-page-title');
  check((await navSubs(page)).length === 0, 'a page with one subsection lists none');
  await shot(page, '6-desktop-appearance-dark');

  // A phone.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  const p = phone.page;
  await p.goto(`${BASE}/dm`);
  await p.waitForSelector('.user-panel-settings');
  await settle(p);
  if (await pane(p) === 'content') await back(p);
  const before = await p.evaluate(() => location.pathname);
  await p.tap('.user-panel-settings');
  await p.waitForURL('**/settings');
  await settle(p);
  check(await pane(p) === 'list', 'the gear opens Settings on its list');
  check(await p.isVisible('.settings-nav') && (await navSubs(p)).length === 0, 'pages listed, no subsections');
  check(!(await wide(p)), 'the list fits the screen');
  await shot(p, '7-phone-list');

  await navButton(p, 'Voice & Video').tap();
  await p.waitForFunction(() => location.pathname === '/settings/voice-video');
  await settle(p);
  check(await pane(p) === 'content', 'a page slides over the list');
  check(await p.isVisible('.settings-page-header .pane-back-button'), 'with the back arrow in its header');
  check(!(await wide(p)), 'the page fits the screen');
  await shot(p, '8-phone-voice');
  await back(p);
  check(await pane(p) === 'list' && await where(p) === '/settings/voice-video', 'Back shows the list (Voice & Video marked)');
  check(await p.$eval('.settings-nav-item.active', (e) => e.textContent) === 'Voice & Video', 'the page just left is marked');
  await navButton(p, 'Notifications').tap();
  await settle(p);
  check(await pane(p) === 'content' && await title(p) === 'Notifications', 'another page');
  await swipeRight(p);
  check(await pane(p) === 'list', 'swiping right shows the list');
  await p.tap('.settings-profile-link');
  await p.waitForSelector('.user-profile.sheet');
  check(await pane(p) === 'list', 'Edit Profile opens your full profile over the list (no page)');
  await shot(p, '9-phone-profile');
  await p.tap('.user-profile-handle');
  await p.waitForSelector('.user-profile', { state: 'detached' });
  await navButton(p, 'Notifications').tap();
  await settle(p);
  await p.tap('.settings-page-header .pane-back-button');
  await p.waitForTimeout(300);
  await settle(p);
  check(await pane(p) === 'list', 'the header\'s arrow shows the list');
  await back(p);
  check(await p.evaluate(() => location.pathname) === before, `Back from the list leaves Settings (${await p.evaluate(() => location.pathname)})`);

  // Fresh loads.
  await p.goto(`${BASE}/settings`);
  await p.waitForSelector('.settings-nav');
  await settle(p);
  check(await pane(p) === 'list', '/settings loaded on its own is the list');
  await p.goto(`${BASE}/settings/privacy#blocked`);
  await p.waitForSelector('.settings-page-title');
  await settle(p);
  check(await pane(p) === 'content' && await title(p) === 'Privacy & Safety', 'a page loaded on its own shows the page');
  await back(p);
  check(await pane(p) === 'list' && (await where(p)).startsWith('/settings/privacy'), 'with the list behind it');
  await p.fill('.settings-search input', 'theme');
  await p.locator('.settings-nav-result').first().tap();
  await settle(p);
  check(await pane(p) === 'content' && await title(p) === 'Appearance', 'a search result opens its page');
  await p.emulateMedia({ colorScheme: 'dark' });
  await shot(p, '10-phone-appearance-dark');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
