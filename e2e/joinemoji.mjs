// A guild's custom emoji show up for someone who joins it, without reloading: Alice uploads one,
// Bob (already logged in, so his emoji list was loaded before he joined) accepts her invite and
// finds it in the picker and in :name: autocomplete.
//   node e2e/serve.mjs &   then   node e2e/joinemoji.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];

// A PNG of a solid colour, 64 pixels square.
function squarePng(file, [r, g, b]) {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const row = Buffer.from([0, ...Array.from({ length: 64 }, () => [r, g, b, 255]).flat()]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header.set([8, 6, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(64).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-joinemoji-'));
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Emoji Guild');
  await a.click('.vc-dialog button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Guild Settings');
  await a.click('.settings-tab:has-text("Emoji")');
  await a.setInputFiles('input[aria-label="Emoji images"]', [squarePng(path.join(dir, 'party_cat.png'), [240, 90, 120])]);
  await a.waitForSelector('.emoji-settings-row input[value="party_cat"]');
  await a.keyboard.press('Escape');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = (await a.inputValue('#invite-link')).replace(/^https?:\/\/[^/]+/, BASE);
  await a.keyboard.press('Escape');
  console.log('alice uploaded :party_cat:');

  // Bob joins in the same page load (the invite page is reached by the app's own navigation).
  await b.evaluate((url) => {
    window.history.pushState({}, '', new URL(url).pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, link);
  const loadsBefore = await b.evaluate(() => performance.timeOrigin);
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');
  if (await b.evaluate(() => performance.timeOrigin) !== loadsBefore) throw new Error('the page reloaded');

  await b.click('button[aria-label="Emoji"]');
  await b.waitForSelector('.emoji-picker-item[aria-label=":party_cat:"]', { timeout: 5000 });
  await b.waitForFunction(() => {
    const img = document.querySelector('.emoji-picker-item[aria-label=":party_cat:"] img');
    return img?.complete && img.naturalWidth > 0;
  });
  if (shots) await b.screenshot({ path: `${shots}/joinemoji-picker.png` });
  console.log('bob sees :party_cat: in the picker without reloading');
  await b.keyboard.press('Escape');

  await b.click('#dm-input');
  await b.keyboard.type(':party_c');
  await b.waitForSelector('text=:party_cat:', { timeout: 5000 });
  console.log('and in :name: autocomplete');
  console.log('OK');
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
