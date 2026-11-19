// Guild Settings' side list: the owner of a guild with the longest name allowed (100 characters,
// no spaces) sees every page grouped down the left (Guild, Emoji and sounds, Features,
// Moderation, then Import and Delete guild below a line), each opening with its title; nothing in
// the dialog is wider than its box on any page (the name cut with an ellipsis), in English and
// Russian, dark and light, at a narrow window too (Roles stacks); the dialog keeps its height
// between pages. Bob, with no permissions, is told so. On a phone: the list alone, a page over it
// with Back, back to the list.
//   node e2e/serve.mjs &   then   node e2e/guildsettings.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

// Every element in the dialog that's wider than the box it sits in, or than the dialog itself.
const overflows = (page) => page.evaluate(() => {
  const dialog = document.querySelector('.guild-settings-dialog');
  const box = dialog.getBoundingClientRect();
  const bad = [];
  if (dialog.scrollWidth > dialog.clientWidth + 1) bad.push(`dialog scrolls sideways (${dialog.scrollWidth} > ${dialog.clientWidth})`);
  for (const el of dialog.querySelectorAll('.vc-dialog-body, .guild-settings-nav, .guild-settings-page')) {
    if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
  }
  for (const el of dialog.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(`${el.tagName.toLowerCase()}.${el.className} sticks out`);
  }
  return bad.slice(0, 5);
});

// Roles' Save bar, stuck while the page scrolls: its bottom at the page's, so nothing shows below it.
const saveBarGap = (page) => page.evaluate(() => {
  const bar = document.querySelector('.role-editor-actions');
  const scroller = document.querySelector('.guild-settings-page');
  return Math.round(scroller.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom);
});

const LONG = 'Supercalifragilisticexpialidocious'.repeat(3) + 'Owls'.repeat(10);
const name = LONG.slice(0, 100);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', name);
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');

  const open = async (page) => {
    await page.click('.guild-header-button');
    await page.click('.guild-menu-item:has-text("Guild Settings")');
    await page.waitForSelector('.guild-settings-dialog');
  };
  const pagesOf = (page) => page.$$eval('.guild-settings-nav .settings-nav-item', (els) => els.map((e) => e.textContent));

  await open(a);
  const cats = await a.$$eval('.guild-settings-nav .settings-nav-category', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(cats) === JSON.stringify(['Guild', 'Emoji and sounds', 'Features', 'Moderation']), `groups: ${cats.join(', ')}`);
  const pages = await pagesOf(a);
  check(JSON.stringify(pages) === JSON.stringify(['Overview', 'Roles', 'Invites', 'Emoji', 'Soundboard', 'Levels', 'Watch Together', 'Bans', 'Import', 'Delete guild']), `pages: ${pages.join(', ')}`);
  check(await a.locator('.guild-settings-nav-group.end .settings-nav-item').count() === 2, 'Import and Delete guild below the line');
  check(await a.$eval('.guild-settings-nav-name', (s) => s.scrollWidth > s.clientWidth && getComputedStyle(s).textOverflow === 'ellipsis'), 'the long name is cut with an ellipsis');
  check(await a.getAttribute('.guild-settings-nav-guild', 'title') === name, 'the whole name in its tooltip');
  check(await a.locator('.guild-settings-back').isHidden(), 'no Back on a computer');

  const height = await a.$eval('.guild-settings-dialog', (d) => d.offsetHeight);
  const walk = async (page, label) => {
    for (const p of await pagesOf(page)) {
      await page.click(`.guild-settings-nav .settings-nav-item:text-is("${p}")`);
      await page.waitForSelector(`.guild-settings-page-title:text-is("${p}")`);
      await page.waitForTimeout(150); // lists load
      const bad = await overflows(page);
      check(bad.length === 0, `${label}: ${p} fits${bad.length ? ` (${bad.join('; ')})` : ''}`);
      check(Math.abs(await page.$eval('.guild-settings-dialog', (d) => d.offsetHeight) - height) < 2, `${label}: ${p} keeps the dialog's height`);
      await shot(page, `${label}-${p.replace(/\W+/g, '-').toLowerCase()}`);
    }
  };
  await walk(a, 'en');
  await a.click('.guild-settings-nav .settings-nav-item:text-is("Roles")');
  await a.waitForSelector('.role-editor-actions');
  let gap = await saveBarGap(a);
  check(Math.abs(gap) <= 1, `Roles' Save bar at the bottom, nothing below it (${gap} px)`);
  await a.click('.guild-settings-nav .settings-nav-item:text-is("Delete guild")');
  check(await a.isDisabled('.guild-settings-danger button'), 'Delete guild waits for the name');
  await a.keyboard.press('Escape');

  // Russian (longer labels), light theme.
  await a.evaluate(() => { localStorage.setItem('voicaw-language', 'ru'); localStorage.setItem('theme', 'light'); });
  await a.reload();
  await a.waitForSelector('.guild-header-button');
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Настройки гильдии")');
  await a.waitForSelector('.guild-settings-dialog');
  await walk(a, 'ru-light');
  await a.keyboard.press('Escape');
  await a.evaluate(() => { localStorage.setItem('voicaw-language', 'en-GB'); localStorage.setItem('theme', 'dark'); });
  await a.reload();
  await a.waitForSelector('.guild-header-button');

  // A narrow window (just above phone layout): Roles stacks its list over its editor.
  await a.setViewportSize({ width: 760, height: 600 });
  await open(a);
  await a.click('.guild-settings-nav .settings-nav-item:text-is("Roles")');
  await a.waitForSelector('.roles-settings');
  check(await a.$eval('.roles-settings', (r) => getComputedStyle(r).flexDirection === 'column'
    && Math.abs(r.querySelector('.roles-list').offsetWidth - r.offsetWidth) < 2), 'narrow: Roles stacks, its list the full width');
  const bad = await overflows(a);
  check(bad.length === 0, `narrow: Roles fits${bad.length ? ` (${bad.join('; ')})` : ''}`);
  await shot(a, 'narrow-roles');
  await a.keyboard.press('Escape');

  // Bob joins with no permissions: told so, no list.
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  const b = bob.page;
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('.guild-channel.active:has-text("general")');
  await b.click('.guild-header-button');
  if (await b.locator('.guild-menu-item:has-text("Guild Settings")').count()) {
    await b.click('.guild-menu-item:has-text("Guild Settings")');
    check(await b.locator('.guild-settings-none').isVisible() && await b.locator('.guild-settings-nav').count() === 0, 'no permissions: told so');
  } else {
    check(true, 'no permissions: no Guild Settings in the menu');
  }

  // Phone: Carol makes her own long-named guild; the list first, a page over it with Back.
  const phone = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const p = phone.page;
  const guild = await p.evaluate(async (guildName) => {
    const res = await fetch('/api/guilds', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: guildName }) });
    return res.json();
  }, name);
  await p.goto(`${BASE}/guild/${guild.id}/${guild.channels[0].id}`);
  await p.waitForSelector('.guild-header-button');
  await open(p);
  check(await p.locator('.guild-settings-nav').isVisible() && await p.locator('.guild-settings-page').isHidden(), 'phone: the list alone');
  check((await overflows(p)).length === 0, 'phone: the list fits');
  await shot(p, 'phone-list');
  await p.click('.guild-settings-nav .settings-nav-item:text-is("Roles")');
  check(await p.locator('.guild-settings-nav').isHidden() && await p.locator('.guild-settings-page-title:text-is("Roles")').isVisible(), 'phone: Roles over the list');
  check((await overflows(p)).length === 0, 'phone: Roles fits');
  gap = await saveBarGap(p);
  check(Math.abs(gap) <= 1, `phone: Roles' Save bar at the bottom (${gap} px)`);
  await shot(p, 'phone-roles');
  await p.click('.guild-settings-back');
  check(await p.locator('.guild-settings-nav').isVisible(), 'phone: Back returns to the list');
  console.log('PASS');
} finally {
  await browser.close();
}
