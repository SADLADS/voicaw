// The desktop app's download popup (stand-in bridge, as e2e/titlebar.mjs): a file finishing
// shows "Download complete" under the title bar's right-hand corner, newest first, a long name
// cut short; Open file / Show in folder / Delete ask the app by id; it stays while hovered and
// goes after 8 s; every theme; on the login page too; none in a plain browser.
//   node e2e/serve.mjs &   then   node e2e/downloads.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const THEMES = ['dark', 'light', 'familiar', 'halloween', 'christmas', 'slack'];

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

function fakeBridge() {
  const on = () => () => () => {};
  window.__downloadCalls = [];
  const record = (name, result) => async (id) => {
    window.__downloadCalls.push([name, id]);
    return typeof result === 'function' ? result(id) : result;
  };
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: () => {},
    setUnread: () => {},
    getSettings: async () => ({ shortcuts: {} }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    getWindowState: async () => ({ maximized: false, fullScreen: false, focused: true }),
    windowAction: () => {},
    downloads: {
      open: record('open', (id) => (id === 3 ? 'missing' : '')),
      showInFolder: record('show'),
      remove: record('remove'),
    },
    onDownload: (cb) => {
      window.__fireDownload = cb;
      return () => {};
    },
    onWindowState: on(),
    onNavigate: on(),
    onShortcut: on(),
    onUpdateReady: on(),
    onUpdateProgress: on(),
  };
}

const fire = (page, id, name) => page.evaluate(([i, n]) => window.__fireDownload({ id: i, name: n, folder: 'Downloads' }), [id, name]);
const calls = (page) => page.evaluate(() => window.__downloadCalls.splice(0));
const box = (page, selector) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width } : null;
}, selector);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  check(await alice.page.evaluate(() => !document.querySelector('.downloads-popup') && !window.voicawDesktop), 'a plain browser has no popup');

  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await context.addInitScript(fakeBridge);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[desktop] page error:', e.message));
  await page.goto(`${BASE}/`);
  await page.waitForSelector('input[placeholder="Username"]');

  // Logged out (a recovery code saved while signing up, say).
  await fire(page, 1, 'voicaw-recovery-code.txt');
  await page.waitForSelector('.downloads-popup');
  check(await page.isVisible('text=Download complete'), 'the login page shows it too');
  await shot(page, 'login');
  await page.click('.downloads-popup-close');
  check(!(await page.isVisible('.downloads-popup')), '× closes it');

  await page.fill('input[placeholder="Username"]', alice.name);
  await page.fill('input[placeholder="Password"]', alice.password);
  await page.press('input[placeholder="Password"]', 'Enter');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  await alice.page.context().close();

  await fire(page, 2, 'holiday-photo.png');
  await fire(page, 3, 'a-very-long-file-name-that-goes-on-and-on-and-on-and-on-and-on-and-on-and-on.tar.gz');
  await page.waitForSelector('.downloads-popup-item >> nth=1');
  const names = await page.$$eval('.downloads-popup-name', (els) => els.map((el) => el.textContent));
  check(names[0].startsWith('a-very-long') && names[1] === 'holiday-photo.png', `newest first (${names.map((n) => n.slice(0, 14)).join(', ')})`);
  check(await page.isVisible('text=Saved in Downloads'), 'says where it was saved');
  await page.waitForTimeout(400); // its slide in
  const popup = await box(page, '.downloads-popup');
  const bar = await box(page, '.title-bar');
  check(popup.top >= bar.bottom + 4 && popup.right <= 1100 - 8 && popup.right >= 1100 - 20, `under the title bar, at the right (${JSON.stringify(popup)})`);
  const longName = await page.$eval('.downloads-popup-name', (el) => ({ cut: el.scrollWidth > el.clientWidth, right: el.getBoundingClientRect().right }));
  check(longName.cut && longName.right <= popup.right, 'a long name is cut short inside it');

  for (const theme of THEMES) {
    await page.evaluate((value) => localStorage.setItem('theme', value), theme);
    await page.reload();
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await fire(page, 2, 'holiday-photo.png');
    await fire(page, 3, 'report-2026-final.pdf');
    await page.waitForSelector('.downloads-popup-item >> nth=1');
    await page.hover('.downloads-popup-delete >> nth=0');
    const look = await page.evaluate(() => {
      const css = (s, p) => getComputedStyle(document.querySelector(s))[p];
      return { bg: css('.downloads-popup', 'backgroundColor'), name: css('.downloads-popup-name', 'color'), open: css('.downloads-popup-open', 'backgroundColor') };
    });
    check(look.bg !== look.name && look.bg !== 'rgba(0, 0, 0, 0)', `${theme}: drawn (${JSON.stringify(look)})`);
    await shot(page, `${theme}`);
  }
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload();
  await page.waitForSelector('#dm-main', { timeout: 20000 });

  await fire(page, 2, 'holiday-photo.png');
  await fire(page, 3, 'gone.zip');
  await page.waitForSelector('.downloads-popup-item >> nth=1');
  await page.click('.downloads-popup-item:has-text("holiday-photo.png") >> text=Show in folder');
  await page.click('.downloads-popup-item:has-text("holiday-photo.png") >> text=Open file');
  await page.waitForFunction(() => document.querySelectorAll('.downloads-popup-item').length === 1);
  check(JSON.stringify(await calls(page)) === JSON.stringify([['show', 2], ['open', 2]]), 'Show in folder and Open file ask by id; Open closes its entry');
  await page.click('text=Open file');
  await page.waitForSelector('text=The file isn\'t there any more');
  check(true, 'a file that has gone says so');
  await page.click('text=Delete');
  await page.waitForSelector('.downloads-popup', { state: 'detached' });
  check(JSON.stringify(await calls(page)) === JSON.stringify([['open', 3], ['remove', 3]]), 'Delete asks by id and the popup goes with the last file');

  // Hovered, it stays past 8 s; then goes 8 s after the pointer leaves.
  await fire(page, 4, 'stay.txt');
  await page.waitForSelector('.downloads-popup');
  await page.hover('.downloads-popup-name');
  await page.waitForTimeout(9000);
  check(await page.isVisible('.downloads-popup'), 'stays while hovered');
  await page.mouse.move(300, 400);
  await page.waitForTimeout(8500);
  check(!(await page.isVisible('.downloads-popup')), 'goes 8 s after the pointer leaves');
} finally {
  await browser.close();
}

console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
