// Guild folders in the rail: drag a guild onto another to make a folder (closed: its guilds
// small), open it, drag a guild into it, rename and recolour it, both kept after a reload (open
// or closed is per device), a guild dragged out, and on a phone a long press drag making one.
//   node e2e/serve.mjs &   then   node e2e/guildfolders.mjs [screenshot dir]
import fs from 'fs';
import path from 'path';
import { BASE, devices, launchChrome, signUp } from './helpers.mjs';

const dir = process.argv[2];
if (dir) fs.mkdirSync(dir, { recursive: true });
const shot = async (page, name) => dir && page.screenshot({ path: path.join(dir, `${name}.png`) });

const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(`/api${u}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${u}: ${res.status}`);
  return res.json();
}, [method, url, body]);

// The rail as text: "Alpha", "[Beta, Gamma]" for a closed folder, "{Beta, Gamma}" an open one.
const rail = (page) => page.$$eval('.rail-guilds > *', (els) => els.map((el) => {
  if (!el.classList.contains('rail-folder')) return el.querySelector('.rail-guild').getAttribute('aria-label');
  const label = el.querySelector('.rail-folder-icon').getAttribute('aria-label');
  return el.classList.contains('open') ? `{${label}}` : `[${label}]`;
}).join(' | '));

async function waitForRail(page, expected) {
  try {
    await page.waitForFunction((want) => {
      const items = [...document.querySelectorAll('.rail-guilds > *')].map((el) => {
        if (!el.classList.contains('rail-folder')) return el.querySelector('.rail-guild').getAttribute('aria-label');
        const label = el.querySelector('.rail-folder-icon').getAttribute('aria-label');
        return el.classList.contains('open') ? `{${label}}` : `[${label}]`;
      });
      return items.join(' | ') === want;
    }, expected, { timeout: 5000 });
  } catch {
    throw new Error(`rail is "${await rail(page)}", expected "${expected}"`);
  }
  console.log('rail:', expected);
}

const center = async (locator) => {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

// A mouse drag from one element's middle to a point.
async function dragTo(page, from, to) {
  const start = await center(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 8, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  return async () => page.mouse.up();
}

const guildIcon = (page, name) => page.locator(`.rail-guild[aria-label="${name}"]`);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) await api(a, 'POST', '/guilds', { name });
  await a.reload();
  await waitForRail(a, 'Alpha | Beta | Gamma | Delta');

  // Gamma onto Alpha's middle: a ring on Alpha while over it, then a folder of the two.
  const alphaMid = await center(guildIcon(a, 'Alpha'));
  const drop = await dragTo(a, guildIcon(a, 'Gamma'), alphaMid);
  await a.waitForSelector('.nav-item.drop-onto .rail-guild[aria-label="Alpha"]');
  await shot(a, '1-combining');
  await drop();
  await waitForRail(a, '[Alpha, Gamma] | Beta | Delta');
  if (await a.locator('.rail-folder-guilds .guild-icon').count() !== 2) throw new Error('closed folder should show its 2 guilds');
  await shot(a, '2-closed-folder');

  // Open it: its guilds below it, on the folder's pill.
  await a.click('.rail-folder-icon');
  await waitForRail(a, '{Alpha, Gamma} | Beta | Delta');
  await shot(a, '3-open-folder');

  // Beta between Alpha and Gamma, inside the open folder (a line shows where).
  const alphaBox = (await center(guildIcon(a, 'Alpha'))).box;
  const gammaBox = (await center(guildIcon(a, 'Gamma'))).box;
  const between = { x: alphaBox.x + alphaBox.width / 2, y: (alphaBox.y + alphaBox.height + gammaBox.y) / 2 };
  const drop2 = await dragTo(a, guildIcon(a, 'Beta'), between);
  await a.waitForSelector('.nav-item.drop-after, .nav-item.drop-before');
  await shot(a, '4-insert-line');
  await drop2();
  await waitForRail(a, '{Alpha, Beta, Gamma} | Delta');

  // Folder Settings: a name and a colour.
  await a.click('.rail-folder-icon', { button: 'right' });
  await a.click('[role="menuitem"]:has-text("Folder Settings")');
  await a.fill('#folder-name', 'Work');
  await a.click('.folder-settings .role-color[aria-label="#e74c3c"]');
  await shot(a, '5-folder-settings');
  await a.click('.folder-settings button:has-text("Save")');
  await waitForRail(a, '{Work} | Delta');
  const color = await a.$eval('.rail-folder', (el) => el.style.getPropertyValue('--rail-folder-color'));
  if (color !== '#e74c3c') throw new Error(`folder colour is ${color}`);

  // Kept after a reload, still open on this device.
  await a.reload();
  await waitForRail(a, '{Work} | Delta');
  const saved = await api(a, 'GET', '/guild-folders');
  console.log('saved folders:', JSON.stringify(saved.map((f) => ({ name: f.name, color: f.color, guilds: f.guildIds.length }))));

  // Closed and opened again, then Gamma dragged out below Delta.
  await a.click('.rail-folder-icon');
  await waitForRail(a, '[Work] | Delta');
  await a.click('.rail-folder-icon');
  const deltaBox = (await center(guildIcon(a, 'Delta'))).box;
  const drop3 = await dragTo(a, guildIcon(a, 'Gamma'), { x: deltaBox.x + deltaBox.width / 2, y: deltaBox.y + deltaBox.height + 30 });
  await drop3();
  await waitForRail(a, '{Work} | Delta | Gamma');

  // The folder dragged whole below Delta.
  const deltaBox2 = (await center(guildIcon(a, 'Delta'))).box;
  const drop4 = await dragTo(a, a.locator('.rail-folder-icon'), { x: deltaBox2.x + deltaBox2.width / 2, y: deltaBox2.y + deltaBox2.height - 6 });
  await drop4();
  await waitForRail(a, 'Delta | {Work} | Gamma');
  await shot(a, '6-moved-folder');

  // Ungroup from its menu.
  await a.click('.rail-folder-icon', { button: 'right' });
  await a.click('[role="menuitem"]:has-text("Ungroup Folder")');
  await waitForRail(a, 'Delta | Alpha | Beta | Gamma');

  // A phone: hold Two, drag it onto One's middle.
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const c = carol.page;
  for (const name of ['One', 'Two']) await api(c, 'POST', '/guilds', { name });
  await c.goto(`${BASE}/dm`);
  await waitForRail(c, 'One | Two');
  // Back to the list pane (the page covers the rail on a phone).
  await c.click('.chat-back-button, button[aria-label="Back"]').catch(() => {});
  await c.waitForTimeout(500);
  const from = await center(guildIcon(c, 'Two'));
  const to = await center(guildIcon(c, 'One'));
  const cdp = await c.context().newCDPSession(c);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', from.x, from.y);
  await c.waitForTimeout(500);
  for (let step = 1; step <= 8; step++) {
    await touch('touchMove', from.x, from.y + (to.y - from.y) * (step / 8));
    await c.waitForTimeout(30);
  }
  await touch('touchEnd');
  await waitForRail(c, '[One, Two]');
  await shot(c, '7-phone-folder');
  console.log('guildfolders: ok');
} catch (err) {
  console.error('guildfolders: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
