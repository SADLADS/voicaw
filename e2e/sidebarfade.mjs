// The side's bottom edge above the user card: guild icons, channels, DMs, Friends and Settings'
// list fade out over its last 10px instead of ending in a hard line against the card's rounded
// corners, in every theme; with a list scrolled to its end, nothing is under the fade.
//   node e2e/serve.mjs &   then   node e2e/sidebarfade.mjs [dir]
import fs from 'fs';
import path from 'path';
import { launchChrome, signUp, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) fs.mkdirSync(dir, { recursive: true });
// The bottom left corner: the side just above the card.
const shot = async (page, name) => {
  if (!dir) return;
  const card = await page.locator('.user-panel').boundingBox();
  const width = await page.evaluate(() => document.querySelector('.sidebar-wrapper').getBoundingClientRect().width);
  await page.screenshot({ path: path.join(dir, `${name}.png`), clip: { x: 0, y: card.y - 90, width, height: 130 } });
};

const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(`/api${u}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${u}: ${res.status}`);
  return res.json();
}, [method, url, body]);

// Scrolls every list in the side's columns to its end and gives how far above the columns'
// bottom the lowest thing drawn in each ends ({ class: px }).
const clearances = (page) => page.evaluate(() => {
  const cols = document.querySelector('.sidebar-columns');
  const bottom = cols.getBoundingClientRect().bottom;
  const out = {};
  for (const s of cols.querySelectorAll('*')) {
    if (s.scrollHeight <= s.clientHeight + 4 || getComputedStyle(s).overflowY === 'visible') continue;
    s.scrollTop = s.scrollHeight;
    let lowest = 0;
    for (const el of s.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && getComputedStyle(el).visibility !== 'hidden') lowest = Math.max(lowest, r.bottom);
    }
    out[s.id || s.className.split(' ')[0]] = Math.round(bottom - lowest);
  }
  return out;
});
const gaps = {};
const check = async (page) => Object.assign(gaps, await clearances(page));

// The rail and the column beside it short of their ends, so an icon and a row pass the card's
// corner.
const railMidway = (page) => page.evaluate(() => {
  for (const s of document.querySelectorAll('.sidebar-columns *')) {
    if (s.scrollHeight > s.clientHeight + 40 && getComputedStyle(s).overflowY !== 'visible') {
      s.scrollTop = s.scrollHeight - s.clientHeight - 36;
    }
  }
});

const theme = (page, t) => page.evaluate((v) => document.documentElement.setAttribute('data-theme', v), t);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 600 } });
  const page = alice.page;
  const friends = [];
  for (let i = 0; i < 9; i++) friends.push(await signUp(browser, `f${i}`));
  await makeFriends(alice, ...friends);
  for (const f of friends) await f.page.context().close();
  let guild;
  for (let i = 0; i < 14; i++) guild = await api(page, 'POST', '/guilds', { name: `Guild ${i}` });
  for (let i = 0; i < 20; i++) await api(page, 'POST', `/guilds/${guild.id}/channels`, { name: `channel-${i}` });
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('.rail-guild');

  await check(page);
  await railMidway(page);
  await shot(page, 'friends');

  await page.goto(`${BASE}/guild/${guild.id}`);
  await page.waitForSelector('text=channel-19');
  await check(page);
  await railMidway(page);
  await shot(page, 'guild');

  await page.goto(`${BASE}/settings/account`);
  await page.waitForTimeout(800);
  await check(page);
  await railMidway(page);
  await shot(page, 'settings');

  for (const t of ['light', 'slack', 'halloween']) {
    await page.goto(`${BASE}/guild/${guild.id}`);
    await page.waitForSelector('text=channel-19');
    await theme(page, t);
    await railMidway(page);
    await shot(page, `guild-${t}`);
  }

  // A phone's list pane: the same card under the rail and the channel list.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  let phoneGuild;
  for (let i = 0; i < 14; i++) phoneGuild = await api(phone.page, 'POST', '/guilds', { name: `Guild ${i}` });
  for (let i = 0; i < 20; i++) await api(phone.page, 'POST', `/guilds/${phoneGuild.id}/channels`, { name: `channel-${i}` });
  await phone.page.goto(`${BASE}/guild/${phoneGuild.id}`, { waitUntil: 'domcontentloaded' });
  await phone.page.tap('.pane-back-button');
  await phone.page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });
  await phone.page.waitForTimeout(400);
  await check(phone.page);
  await railMidway(phone.page);
  await shot(phone.page, 'phone');

  const fade = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.sidebar-columns'), '::after');
    return { image: s.backgroundImage, height: s.height };
  });
  if (!/gradient/.test(fade.image) || fade.height !== '10px') throw new Error(`no fade on the side's columns: ${JSON.stringify(fade)}`);
  const covered = Object.entries(gaps).filter(([, px]) => px < 10);
  if (covered.length) throw new Error(`scrolled to the end, still under the fade: ${JSON.stringify(gaps)}`);
  console.log(`sidebarfade: ok (lists' ends above the bottom: ${JSON.stringify(gaps)})`);
} catch (err) {
  console.error('sidebarfade: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
