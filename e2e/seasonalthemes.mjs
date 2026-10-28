// Seasonal themes and Christmas: the browser's date is set by hand (Playwright's clock), so the
// app switches to Christmas on opening in December and puts Light back in January; a theme
// chosen in December is kept past the month; Settings → Appearance → Seasonal themes off puts
// the usual theme back at once and stops the switching; an app left open over the 1st switches
// when it comes back into view. Screenshots of Christmas (settings, DM, guild, phone).
//   node e2e/serve.mjs &   then   node e2e/seasonalthemes.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const themeOf = (page) => page.evaluate(() => document.documentElement.dataset.theme);

// Opens the app on that day (noon, local time).
async function openOn(page, day, path = '/dm') {
  await page.clock.setFixedTime(new Date(`${day}T12:00:00`));
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector('#dm-main, .dm-sidebar, #settings-theme', { timeout: 20000 });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  await openChat(a, bob.id);
  await send(a, 'Merry **Christmas**, `code` and https://example.com');

  // November: Light chosen in Settings.
  await openOn(a, '2026-11-20', '/settings/appearance');
  await a.click('#settings-theme >> text=Light');
  check((await themeOf(a)) === 'light', 'Light chosen in November');
  check(await a.isChecked('#settings-seasonal-themes input[type=checkbox]'), 'Seasonal themes on by default');

  // 1 December: Christmas on opening; Light back on 1 January.
  await openOn(a, '2026-12-01', `/dm/${bob.id}`);
  check((await themeOf(a)) === 'christmas', 'opening the app on 1 December: Christmas');
  await a.waitForSelector('text=Merry');
  await shot(a, 'christmas-dm');
  await openOn(a, '2026-12-24');
  check((await themeOf(a)) === 'christmas', 'still Christmas later in the month');
  await openOn(a, '2027-01-01');
  check((await themeOf(a)) === 'light', '1 January: Light again');

  // Opened first on 10 December: switches then; a theme picked after that is kept, then and after the month.
  await openOn(a, '2027-12-10', '/settings/appearance');
  check((await themeOf(a)) === 'christmas', 'first opened on 10 December: Christmas');
  await shot(a, 'christmas-settings');
  await a.click('#settings-theme >> text=Ol’ Familiar');
  await openOn(a, '2027-12-11');
  check((await themeOf(a)) === 'familiar', 'Ol’ Familiar chosen in December is kept the next day');
  await openOn(a, '2028-01-02');
  check((await themeOf(a)) === 'familiar', 'and after the month');

  // October: Halloween; turning seasonal themes off puts Ol' Familiar back at once and for good.
  await openOn(a, '2028-10-03', '/settings/appearance');
  check((await themeOf(a)) === 'halloween', '3 October: Halloween');
  await a.click('#settings-seasonal-themes input[type=checkbox]');
  check((await themeOf(a)) === 'familiar', 'Seasonal themes off: Ol’ Familiar back at once');
  await openOn(a, '2028-12-05', '/settings/appearance');
  check((await themeOf(a)) === 'familiar', 'and no Christmas while it is off');
  check(!(await a.isChecked('#settings-seasonal-themes input[type=checkbox]')), 'off kept after reloads');

  // On again in November; the app left open over 1 December switches when it's looked at again.
  await openOn(a, '2028-11-30', '/settings/appearance');
  await a.click('#settings-seasonal-themes input[type=checkbox]');
  check((await themeOf(a)) === 'familiar', 'turned on in November: nothing changes');
  await a.clock.setFixedTime(new Date('2028-12-01T09:00:00'));
  await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await a.waitForFunction(() => document.documentElement.dataset.theme === 'christmas');
  check(true, 'left open over 1 December: Christmas when it comes back into view');

  // A guild in Christmas, and a phone.
  await a.goto(`${BASE}/guild`);
  await a.waitForTimeout(800);
  await shot(a, 'christmas-guilds');
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.clock.setFixedTime(new Date('2026-12-02T12:00:00'));
  await p.goto(`${BASE}/`);
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.keyboard.press('Enter');
  await p.waitForSelector('#dm-main, .dm-sidebar', { timeout: 20000 });
  check((await themeOf(p)) === 'christmas', 'phone (its own device) switches too');
  await p.goto(`${BASE}/dm/${bob.id}`);
  await p.waitForSelector('text=Merry');
  await shot(p, 'christmas-dm-phone');

  console.log('seasonalthemes: ok');
} catch (err) {
  console.error('seasonalthemes: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
