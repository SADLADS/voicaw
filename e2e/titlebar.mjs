// The desktop app's title bar, page side (a stand-in bridge, as e2e/desktop.mjs; the real window
// is checked under Xvfb, see README): only with the bridge (not on the web, not on a phone), the
// page fits below it (nothing scrolls, the sidebar ends at the bottom), the title and the guild's
// icon, back and forward, the window buttons, the theme's colours, and the inbox: Alice's DM
// decrypted on the device and her mention in a guild, unread marked, a click opens it.
//   node e2e/serve.mjs &   then   node e2e/titlebar.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

function fakeBridge() {
  const record = { windowActions: [] };
  const listeners = {};
  window.__desktop = { record, emit: (name, value) => listeners[name]?.(value) };
  const on = (name) => (cb) => { listeners[name] = cb; return () => {}; };
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: () => {},
    setUnread: () => {},
    getSettings: async () => ({ shortcuts: {} }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    getWindowState: async () => ({ maximized: false, fullScreen: false, focused: true }),
    windowAction: (action) => record.windowActions.push(action),
    onWindowState: on('windowState'),
    onNavigate: on('navigate'),
    onShortcut: on('shortcut'),
    onUpdateReady: on('updateReady'),
    onUpdateProgress: on('updateProgress'),
  };
}

const fits = (page) => page.evaluate(() => {
  const bar = document.querySelector('.title-bar')?.getBoundingClientRect();
  const sidebar = document.querySelector('.sidebar-wrapper')?.getBoundingClientRect();
  return {
    bar: bar && { top: bar.top, height: bar.height, width: bar.width },
    sidebarTop: sidebar?.top,
    sidebarBottom: sidebar?.bottom,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrolls: document.documentElement.scrollHeight > window.innerHeight || document.scrollingElement.scrollTop > 0,
  };
});

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await bobContext.addInitScript(fakeBridge);
  const bob = await signUp(browser, 'bob').then(async (b) => {
    const page = await bobContext.newPage();
    page.on('pageerror', (e) => console.log('[bob desktop] page error:', e.message));
    await page.goto(`${BASE}/`);
    check(Boolean(await page.waitForSelector('.title-bar', { timeout: 10000 }).catch(() => null)), 'the login page has the title bar too');
    check(!(await page.$('.title-bar .inbox')), 'but no inbox before logging in');
    await shot(page, 'login');
    await page.fill('input[placeholder="Username"]', b.name);
    await page.fill('input[placeholder="Password"]', b.password);
    await page.press('input[placeholder="Password"]', 'Enter');
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await b.page.context().close();
    return { ...b, page };
  });
  const page = bob.page;

  check(!(await alice.page.$('.title-bar')), 'the web app has no title bar');
  check(!(await alice.page.evaluate(() => document.documentElement.classList.contains('has-title-bar'))), 'nor its room');
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${BASE}/`);
  await phonePage.waitForSelector('input[placeholder="Username"]');
  check(!(await phonePage.$('.title-bar')), 'nor does a phone');
  await phone.close();

  // Bob checks Alice's keys once (DM previews need that), then Alice writes to him.
  await openChat(page, alice.id);
  await page.goto(`${BASE}/dm/friends`);
  await page.waitForSelector('.title-bar-text');
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello from alice');
  await alice.page.waitForTimeout(1000);

  const layout = await fits(page);
  check(layout.bar?.top === 0 && layout.bar.height === 32 && layout.bar.width === layout.innerWidth, `the bar is 32 px across the top (${JSON.stringify(layout.bar)})`);
  check(layout.sidebarTop === 32 && Math.abs(layout.sidebarBottom - layout.innerHeight) < 1, `the sidebar runs from under it to the bottom (${layout.sidebarTop}–${layout.sidebarBottom} of ${layout.innerHeight})`);
  check(!layout.scrolls, 'nothing scrolls');
  check((await page.textContent('.title-bar-text')) === 'Friends', 'the title is the page\'s');

  // A guild: its name and icon; Alice mentions Bob there.
  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Title club' });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(page, 'POST', `/invites/${invite.code}`);
  const channelId = guild.channels[0].id;
  await api(alice.page, 'POST', `/channels/${channelId}/messages`, { content: `look <@${bob.id}>` });
  await page.goto(`${BASE}/dm/friends`);
  await page.waitForSelector('.title-bar-text');
  await page.click(`[aria-label="Title club"], [title="Title club"]`).catch(async () => {
    await page.evaluate((url) => { window.history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/guild/${guild.id}/${channelId}`);
  });
  await page.waitForFunction(() => document.querySelector('.title-bar-text')?.textContent === 'Title club', null, { timeout: 10000 });
  check(Boolean(await page.$('.title-bar-title .title-bar-guild-icon')), 'in a guild: its name with its icon');
  await shot(page, 'guild');

  // Back and forward, as the browser's.
  const guildUrl = page.url();
  await page.click('.title-bar button[aria-label="Back"]');
  await page.waitForFunction(() => location.pathname === '/dm/friends');
  check(true, 'Back goes back');
  check(!(await page.$('.title-bar-guild-icon')), 'and the guild icon goes');
  await page.click('.title-bar button[aria-label="Forward"]');
  await page.waitForFunction((url) => location.href === url, guildUrl);
  check(true, 'Forward comes forward again');
  check(await page.$eval('.title-bar button[aria-label="Forward"]', (b) => b.disabled), 'Forward is greyed out with nowhere to go');

  // The window buttons.
  for (const name of ['Minimise', 'Maximise', 'Close']) await page.click(`.title-bar button[aria-label="${name}"]`);
  const actions = (await page.evaluate(() => window.__desktop.record)).windowActions;
  check(actions.join() === 'minimize,maximize,close', `the window buttons ask the app (${actions.join()})`);
  await page.evaluate(() => window.__desktop.emit('windowState', { maximized: true, fullScreen: false, focused: true }));
  check(Boolean(await page.waitForSelector('.title-bar button[aria-label="Restore"]', { timeout: 3000 }).catch(() => null)), 'maximised, Maximise becomes Restore');

  // The theme's colours: the rail's, in dark and light.
  const colours = () => page.evaluate(() => {
    const bar = getComputedStyle(document.querySelector('.title-bar')).backgroundColor;
    const probe = document.createElement('div');
    probe.style.background = 'var(--vc-bg-rail)';
    document.body.append(probe);
    const rail = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { bar, rail };
  });
  const dark = await colours();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const light = await colours();
  check(dark.bar === dark.rail && light.bar === light.rail && dark.bar !== light.bar, `follows the theme (dark ${dark.bar}, light ${light.bar})`);
  await shot(page, 'light');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  // The inbox.
  await page.click('.title-bar button[aria-label="Inbox"]');
  await page.waitForSelector('.inbox-entry', { timeout: 10000 });
  const entries = await page.$$eval('.inbox-entry', (els) => els.map((e) => ({
    title: e.querySelector('.inbox-entry-title').textContent,
    body: e.querySelector('.inbox-entry-body').textContent,
    unread: e.classList.contains('unread'),
  })));
  console.log('     inbox:', JSON.stringify(entries));
  check(entries.length === 2, 'the inbox has the mention and the DM');
  check(entries.some((e) => e.body === 'hello from alice' && e.unread), "the DM decrypted on the device, unread");
  check(entries.some((e) => e.body.includes(`@${bob.name}`) && e.title.includes('#general') && e.title.includes('Title club')), 'the mention, worded as its notification');
  const panel = await page.$eval('.inbox-panel', (p) => { const r = p.getBoundingClientRect(); return { right: r.right, bottom: r.bottom }; });
  check(panel.right <= 1100 && panel.bottom <= 750, 'the panel fits the window');
  await shot(page, 'inbox');
  await page.click('.inbox-entry:has-text("hello from alice")');
  await page.waitForFunction((id) => location.pathname === `/dm/${id}`, alice.id);
  check(!(await page.$('.inbox-panel')), 'clicking one opens its chat and closes the inbox');
  await page.click('.title-bar button[aria-label="Inbox"]');
  await page.waitForSelector('.inbox-panel');
  await page.keyboard.press('Escape');
  check(!(await page.$('.inbox-panel')), 'Escape closes it');
} finally {
  await browser.close();
}

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
