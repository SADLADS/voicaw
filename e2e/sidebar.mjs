// Sidebar column and headers on a computer: the DM list, channel list and Settings' column are
// one width; every header (list and page beside it) is the same height, so their lines meet;
// dragging the edge (and arrows, double click, limits) changes all of them and is kept after a
// reload; on a phone the lists stay full width, Settings one screen, and there's no handle.
//   node e2e/serve.mjs &   then   node e2e/sidebar.mjs [screenshot dir]
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';
const dir = process.argv[2];
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const browser = await launchChrome();
const box = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, w: Math.round(r.width), bottom: Math.round(r.bottom) }; }, sel);
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); })));
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) process.exitCode = 1; };
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;

  async function pages(tag, guildUrl) {
    await a.goto(`${BASE}/dm/${bob.id}`);
    await a.waitForSelector('#dm-input'); await a.waitForTimeout(300); await settle(a);
    const dmList = await box(a, '#dm-sidebar'), dmListHead = await box(a, '.direct-messages-header'), dmHead = await box(a, '.chat-recipient-header');
    console.log(tag, 'dm', dmList, dmListHead, dmHead);
    await shot(a, `${tag}-dm`);
    await a.goto(`${BASE}/dm/notes`);
    await a.waitForSelector('.chat-recipient-header'); await settle(a);
    const notesHead = await box(a, '.chat-recipient-header');
    await a.goto(guildUrl);
    await a.waitForSelector('#dm-input'); await a.waitForTimeout(300); await settle(a);
    const gList = await box(a, '.guild-sidebar'), gHead = await box(a, '.guild-header'), cHead = await box(a, '.channel-header');
    console.log(tag, 'guild', gList, gHead, cHead);
    await shot(a, `${tag}-guild`);
    await a.goto(`${BASE}/settings`);
    await a.waitForSelector('.settings-nav'); await a.waitForTimeout(300); await settle(a);
    const sNav = await box(a, '.settings-nav'), sHead = await box(a, '.settings-header'), pageHead = await box(a, '.settings-page-header');
    console.log(tag, 'settings', sNav, sHead, 'page header', pageHead);
    await shot(a, `${tag}-settings`);
    check(`${tag}: same width everywhere (${dmList.w}, ${gList.w}, ${sNav.w})`, dmList.w === gList.w && gList.w === sNav.w);
    check(`${tag}: headers 50 (${dmListHead.bottom} ${dmHead.bottom} ${notesHead.bottom} ${gHead.bottom} ${cHead.bottom} ${sHead.bottom})`, [dmListHead, dmHead, notesHead, gHead, cHead, sHead].every((b) => b.bottom === 50));
    check(`${tag}: settings page header meets the column's (${pageHead.bottom})`, pageHead.bottom === 50);
    return dmList.w;
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Test Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  const guildUrl = a.url();

  const before = await pages('default', guildUrl);
  check('default is 260', before === 260);

  // Drag the edge 80px right, on the guild page.
  await a.goto(guildUrl); await a.waitForSelector('.sidebar-resizer');
  const r = await box(a, '.sidebar-resizer');
  await a.mouse.move(r.x + 3, 300); await a.mouse.down();
  for (let i = 1; i <= 8; i += 1) await a.mouse.move(r.x + 3 + i * 10, 300);
  await a.mouse.up(); await settle(a);
  check('dragged to 340', (await box(a, '.guild-sidebar')).w === 340);
  const after = await pages('dragged', guildUrl);
  check('kept after reloads', after === 340);
  // Keys and double click.
  await a.focus('.sidebar-resizer'); await a.keyboard.press('ArrowLeft'); await settle(a);
  check('arrow left 330', (await box(a, '.settings-nav')).w === 330);
  await a.dblclick('.sidebar-resizer'); await settle(a);
  check('double click back to 260', (await box(a, '.settings-nav')).w === 260);
  // Can't go past the limits.
  const r2 = await box(a, '.sidebar-resizer');
  await a.mouse.move(r2.x + 3, 300); await a.mouse.down(); await a.mouse.move(r2.x - 300, 300); await a.mouse.up(); await settle(a);
  check('min 200', (await box(a, '.settings-nav')).w === 200);

  // Phone: Settings' list (its page slides over it), full-width lists, no handle.
  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: await a.context().storageState() });
  const p = await phone.newPage();
  await p.goto(`${BASE}/settings`); await p.waitForSelector('.settings-nav'); await p.waitForTimeout(500);
  check('phone: no handle', (await p.$('.sidebar-resizer')) === null);
  await shot(p, `phone-settings`);
  await p.goto(`${BASE}/dm`); await p.waitForSelector('#dm-sidebar', { state: 'attached' }); await p.waitForTimeout(500);
  const vw = p.viewportSize().width;
  check(`phone: dm list fills (${(await box(p, '#dm-sidebar')).w} of ${vw - 72})`, (await box(p, '#dm-sidebar')).w === vw - 72);
  await shot(p, `phone-dmlist`);
  await p.goto(`${BASE}/dm/${bob.id}`); await p.waitForSelector('#dm-input'); await p.waitForTimeout(500);
  await shot(p, `phone-dm`);
  await p.goto(guildUrl); await p.waitForSelector('#dm-input'); await p.waitForTimeout(500);
  await shot(p, `phone-guild`);
} catch (e) { console.error('FAILED', e.message); process.exitCode = 1; } finally { await browser.close(); }
