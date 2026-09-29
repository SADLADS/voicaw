// Custom emoji and the server rail order in a real browser: upload emoji in Server Settings,
// see each server's section in the picker (in your rail order, with the server's icon), use
// them by picker, :name: and as reactions (in a server and a DM), and drag servers around
// the rail (mouse, and a long press on a phone).
//   node e2e/serve.mjs &   then   node e2e/emoji.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchChrome, signUp, openChat, devices, fakeObjectStore, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// A 64×64 PNG of a coloured disc.
function discPng(file, [r, g, b]) {
  const size = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const inside = (x - 31.5) ** 2 + (y - 31.5) ** 2 <= 30 ** 2;
      row.push(...(inside ? [r, g, b, 255] : [0, 0, 0, 0]));
    }
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

async function createGuild(page, name) {
  await page.click('button[aria-label="Add a server"]');
  await page.fill('#new-guild-name', name);
  await page.click('.vc-dialog button:has-text("Create")');
  await page.waitForSelector(`.guild-header-name:has-text("${name}")`);
  await page.waitForSelector('#dm-input');
  return page.url().match(/\/guild\/(\d+)/)[1];
}

async function inviteLink(page) {
  await page.click('.guild-header-button');
  await page.click('text=Invite People');
  await page.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await page.inputValue('#invite-link');
  await page.keyboard.press('Escape');
  return link.replace(/^https?:\/\/[^/]+/, BASE);
}

async function join(page, link) {
  await page.goto(link);
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

async function uploadEmoji(page, guildId, files) {
  await page.click(`.rail-guild[href="/guild/${guildId}"]`);
  await page.waitForSelector('#dm-input');
  await page.click('.guild-header-button');
  await page.click('text=Server Settings');
  await page.click('.settings-tab:has-text("Emoji")');
  await page.setInputFiles('input[aria-label="Emoji images"]', files);
  for (const file of files) {
    await page.waitForSelector(`.emoji-settings-row input[value="${path.basename(file, '.png')}"]`);
  }
}

const railOrder = (page) => page.$$eval('.rail-guild', (els) => els.map((e) => e.getAttribute('aria-label')));
const pickerHeadings = (page) => page.$$eval('.emoji-picker-section-title', (els) => els.map((e) => e.textContent));
// Whether every custom emoji image in `selector` has loaded.
const imagesLoaded = (page, selector) => page.$$eval(selector, (imgs) => imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-emoji-'));
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  await fakeObjectStore(a.context());
  await fakeObjectStore(b.context());

  const alpha = await createGuild(a, 'Alpha Server');
  const alphaLink = await inviteLink(a);
  const beta = await createGuild(a, 'Beta Server');
  const betaLink = await inviteLink(a);
  await join(b, alphaLink);
  await join(b, betaLink);

  // Emoji: two in Beta, one in Alpha.
  await uploadEmoji(a, beta, [discPng(path.join(dir, 'blob.png'), [80, 160, 255]), discPng(path.join(dir, 'wave_hi.png'), [240, 90, 120])]);
  await shot(a, 'emoji-settings');
  await a.keyboard.press('Escape');
  await uploadEmoji(a, alpha, [discPng(path.join(dir, 'alpha_star.png'), [250, 200, 40])]);
  await a.keyboard.press('Escape');
  console.log('uploaded 3 emoji');

  // Alice drags Beta above Alpha in the rail (mouse).
  console.log('alice rail before:', (await railOrder(a)).join(', '));
  const betaIcon = await a.locator(`.rail-guild[href="/guild/${beta}"]`).boundingBox();
  const alphaIcon = await a.locator(`.rail-guild[href="/guild/${alpha}"]`).boundingBox();
  await a.mouse.move(betaIcon.x + 24, betaIcon.y + 24);
  await a.mouse.down();
  await a.mouse.move(betaIcon.x + 24, betaIcon.y + 10, { steps: 3 });
  await a.mouse.move(alphaIcon.x + 24, alphaIcon.y + 8, { steps: 8 });
  await a.mouse.up();
  await a.waitForFunction(() => document.querySelector('.rail-guild')?.getAttribute('aria-label') === 'Beta Server');
  console.log('alice rail after drag:', (await railOrder(a)).join(', '));
  await a.reload();
  await a.waitForSelector('.rail-guild');
  const afterReload = await railOrder(a);
  console.log('alice rail after reload:', afterReload.join(', '));
  if (afterReload[0] !== 'Beta Server') throw new Error('rail order not saved');

  // The picker follows each person's own rail order.
  await a.click(`.rail-guild[href="/guild/${alpha}"]`);
  await a.waitForSelector('#dm-input');
  await a.click('button[aria-label="Emoji"]');
  await a.waitForSelector('.emoji-picker-section-title');
  const aliceSections = await pickerHeadings(a);
  console.log('alice picker sections:', aliceSections.slice(0, 3).join(', '));
  if (aliceSections[0] !== 'Beta Server' || aliceSections[1] !== 'Alpha Server') throw new Error('wrong section order for alice');
  await a.waitForFunction(() => [...document.querySelectorAll('.emoji-picker-item img')].slice(0, 3).every((i) => i.complete && i.naturalWidth > 0));
  await a.hover('.emoji-picker-item[aria-label=":blob:"]');
  await shot(a, 'picker-custom');
  await a.click('.emoji-picker-item[aria-label=":blob:"]');

  await b.click(`.rail-guild[href="/guild/${alpha}"]`);
  await b.waitForSelector('#dm-input');
  await b.click('button[aria-label="Emoji"]');
  await b.waitForSelector('.emoji-picker-section-title');
  const bobSections = await pickerHeadings(b);
  console.log('bob picker sections:', bobSections.slice(0, 3).join(', '));
  if (bobSections[0] !== 'Alpha Server' || bobSections[1] !== 'Beta Server') throw new Error('wrong section order for bob');
  await b.keyboard.press('Escape');

  // Alice sends: the picked :blob:, then a typed :wave_hi: and an emoji-only message.
  await a.keyboard.type(' and ');
  await a.keyboard.type(':wave_hi:');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input img.emoji').length === 2);
  await a.keyboard.press('Enter');
  await a.keyboard.type(':alpha_star:');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input img.emoji').length === 1);
  await a.keyboard.press('Enter');
  await b.waitForSelector('.dm-message-content.emoji-only img.custom-emoji');
  await b.waitForFunction(() => [...document.querySelectorAll('.dm-message-content img.custom-emoji')].every((i) => i.complete && i.naturalWidth > 0));
  console.log('bob sees the custom emoji, loaded:', await imagesLoaded(b, '.dm-message-content img.custom-emoji'));

  // Bob reacts with one from the picker.
  const first = b.locator('.each-dm-message-wrapper').first();
  await first.hover();
  await first.locator('button[aria-label="Add reaction"]').click();
  await b.fill('input[aria-label="Search emoji"]', 'wave');
  await b.click('.emoji-picker-item[aria-label=":wave_hi:"]');
  await a.waitForSelector('.reaction-chip img[alt=":wave_hi:"]');
  console.log('custom reaction delivered');
  await shot(b, 'chat-custom');

  // In an encrypted DM too.
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  await a.click('#dm-input');
  await a.keyboard.type('dm :blob:');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input img.emoji').length === 1);
  await a.keyboard.press('Enter');
  await b.waitForSelector('.dm-message-content img.custom-emoji[alt=":blob:"]');
  console.log('custom emoji works in a DM');

  // A phone: hold a server, then drag it.
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const c = carol.page;
  await fakeObjectStore(c.context());
  await join(c, alphaLink);
  await join(c, betaLink);
  await c.evaluate(() => document.querySelector('.main-wrapper').scrollTo({ left: 0, behavior: 'instant' }));
  await c.waitForTimeout(300);
  console.log('carol rail before:', (await railOrder(c)).join(', '));
  const from = await c.locator(`.rail-guild[href="/guild/${beta}"]`).boundingBox();
  const to = await c.locator(`.rail-guild[href="/guild/${alpha}"]`).boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const x = from.x + from.width / 2;
  await touch('touchStart', x, from.y + from.height / 2);
  await c.waitForTimeout(500);
  for (let step = 1; step <= 8; step++) {
    await touch('touchMove', x, from.y + from.height / 2 + ((to.y + 5) - (from.y + from.height / 2)) * (step / 8));
    await c.waitForTimeout(30);
  }
  await touch('touchEnd');
  await c.waitForFunction(() => document.querySelector('.rail-guild')?.getAttribute('aria-label') === 'Beta Server');
  console.log('carol rail after long-press drag:', (await railOrder(c)).join(', '));
  // The docked picker on the phone, with the servers' sections.
  await c.goto(`${BASE}/guild/${alpha}`);
  await c.waitForSelector('#dm-input');
  await c.click('button[aria-label="Emoji"]');
  await c.waitForSelector('.emoji-picker.docked .emoji-picker-section-title');
  await c.waitForTimeout(500);
  await shot(c, 'mobile-picker');

  console.log('emoji e2e: ok');
} catch (err) {
  console.error('emoji e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  for (const page of browser.contexts().flatMap((ctx) => ctx.pages())) {
    console.error('  message box:', await page.$eval('#dm-input', (el) => el.innerHTML).catch(() => '(none)'));
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
