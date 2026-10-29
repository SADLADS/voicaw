// Every theme on the same pages (desktop app with a stand-in bridge, as e2e/titlebar.mjs):
// a guild channel with the inbox open, and Settings with its gear. In Slack the title bar and
// the inbox are the rail's aubergine, and the gear's "you're here" tint is the open row's.
//   node e2e/serve.mjs &   then   node e2e/themeparts.mjs [screenshot dir]
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
  const on = () => () => () => {};
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
    onWindowState: on(),
    onNavigate: on(),
    onShortcut: on(),
    onUpdateReady: on(),
    onUpdateProgress: on(),
  };
}

// The computed colours of a few parts.
const colours = (page) => page.evaluate(() => {
  const bg = (selector) => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  return {
    bar: bg('.title-bar'),
    rail: bg('.sidebar-wrapper > :first-child') ?? null,
    railToken: getComputedStyle(document.querySelector('.sidebar-wrapper')).getPropertyValue('--vc-bg-rail').trim(),
    barToken: getComputedStyle(document.querySelector('.title-bar')).getPropertyValue('--vc-bg-rail').trim(),
    panel: bg('.inbox-panel'),
    popupToken: getComputedStyle(document.querySelector('.title-bar')).getPropertyValue('--vc-popup').trim(),
    gear: bg('.user-panel-settings'),
    openRow: bg('.guild-channel.active'),
  };
});

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await context.addInitScript(fakeBridge);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[desktop] page error:', e.message));
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="Username"]', alice.name);
  await page.fill('input[placeholder="Password"]', alice.password);
  await page.press('input[placeholder="Password"]', 'Enter');
  await page.waitForSelector('#dm-main', { timeout: 20000 });
  await alice.page.context().close();
  const guild = await api(page, 'POST', '/guilds', { name: 'Theme club' });
  const channel = guild.channels[0];

  for (const theme of THEMES) {
    await page.evaluate((value) => localStorage.setItem('theme', value), theme);
    await page.goto(`${BASE}/guild/${guild.id}/${channel.id}`);
    await page.waitForSelector('#dm-input');
    await page.click('.title-bar button[aria-label="Inbox"]');
    await page.waitForSelector('.inbox-panel');
    const inGuild = await colours(page);
    await shot(page, `${theme}-guild`);
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/settings`);
    await page.waitForSelector('.user-panel-settings.active');
    const inSettings = await colours(page);
    await shot(page, `${theme}-settings`);
    console.log(`     ${theme}:`, JSON.stringify({ ...inGuild, gear: inSettings.gear }));
    check(theme !== 'slack' || (inGuild.popupToken === '#350c36' && inGuild.panel === 'rgb(53, 12, 54)'), `${theme}: the inbox is the bar's popup colour (${inGuild.panel})`);
    check(inGuild.barToken === inGuild.railToken, `${theme}: the title bar is the rail's colour (${inGuild.barToken})`);
    check(inSettings.gear === inGuild.openRow, `${theme}: the gear on Settings has the open row's tint (${inSettings.gear})`);
  }
} finally {
  await browser.close();
}

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
