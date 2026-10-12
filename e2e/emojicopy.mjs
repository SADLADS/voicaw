// Copying and pasting in the message box keeps custom emoji and mentions: Alice types
// ":clueless:" (it becomes the emoji's picture) and picks @bob, then Ctrl+A, Ctrl+C, Ctrl+V
// (the real keyboard shortcuts, through Chrome's own clipboard). The clipboard holds the message
// text (<:clueless:id> <@id>), the box still shows the picture and the chip, a second paste adds
// both again, and the sent message has them twice.
//   node e2e/serve.mjs &   then   node e2e/emojicopy.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = (page, name) => (shots ? page.screenshot({ path: `${shots}/emojicopy-${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const api = (page, method, p, body) => page.evaluate(async ([m, url, b]) => {
  const res = await fetch(`/api${url}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${url}: ${res.status}`);
  return res.json();
}, [method, p, body]);

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

const box = (page) => page.evaluate(() => {
  const el = document.querySelector('#dm-input');
  return {
    emoji: el.querySelectorAll('img.emoji').length,
    mentions: [...el.querySelectorAll('.mention')].map((m) => m.textContent),
    text: el.textContent,
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-emojicopy-'));
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  // Ctrl+C / Ctrl+V go through the system clipboard; reading it back needs the permission.
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  const guild = await api(a, 'POST', '/guilds', { name: 'Copy Guild' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(a, 'POST', `/guilds/${guildId}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await a.goto(`${BASE}/guild/${guildId}`);
  await a.waitForSelector('#dm-input');

  await a.click('.guild-header-button');
  await a.click('text=Guild Settings');
  await a.click('.settings-tab:has-text("Emoji")');
  await a.setInputFiles('input[aria-label="Emoji images"]', [squarePng(path.join(dir, 'clueless.png'), [90, 160, 240])]);
  await a.waitForSelector('.emoji-settings-row input[value="clueless"]');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.settings-tab', { state: 'detached' }).catch(() => {});

  // Type the emoji and a mention, as people do.
  await a.click('#dm-input');
  await a.keyboard.type(':clueless: ');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input img.emoji').length === 1);
  await a.keyboard.type(`hi @${bob.name.slice(0, 4)}`);
  await a.waitForSelector('.mention-suggestions');
  await a.keyboard.press('Enter');
  await a.waitForSelector('#dm-input .mention');
  const before = await box(a);
  check(before.emoji === 1 && before.mentions.join() === `@${bob.name}`, `the box has the emoji picture and @${bob.name}`);
  await shot(a, 'typed');

  // Select all, copy: the clipboard holds message text.
  await a.keyboard.press('Control+A');
  await a.keyboard.press('Control+C');
  const copied = await a.evaluate(() => navigator.clipboard.readText());
  console.log(`  clipboard: ${JSON.stringify(copied)}`);
  check(/^<:clueless:\w+>\s+hi <@\d+>\s*$/.test(copied), 'copied as <:clueless:id> hi <@id>');

  // Paste over the selection: nothing lost.
  await a.keyboard.press('Control+V');
  await a.waitForTimeout(200);
  const once = await box(a);
  check(once.emoji === 1, 'after pasting over everything the box still shows the emoji picture');
  check(once.mentions.join() === `@${bob.name}`, 'and the mention chip');
  check(await a.$eval('#dm-input img.emoji', (img) => img.complete && img.naturalWidth > 0), 'the picture has loaded');
  await shot(a, 'pasted');

  // Paste again at the end: two of each.
  await a.keyboard.press('Control+End');
  await a.keyboard.press('Control+V');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input img.emoji').length === 2, null, { timeout: 3000 });
  const twice = await box(a);
  check(twice.emoji === 2 && twice.mentions.length === 2, 'a second paste adds the emoji and the mention again');
  await shot(a, 'pasted-twice');

  // Sending: the message has both emoji and both mentions.
  await a.keyboard.press('Enter');
  const msg = await a.waitForSelector('.dm-message-content img.custom-emoji', { timeout: 10000 });
  const sent = await msg.evaluate((img) => {
    const content = img.closest('.dm-message-content');
    return {
      emoji: content.querySelectorAll('img.custom-emoji').length,
      alt: content.querySelector('img.custom-emoji').alt,
      mentions: [...content.querySelectorAll('.mention')].map((m) => m.textContent),
    };
  });
  check(sent.emoji === 2 && sent.alt === ':clueless:', 'the sent message shows :clueless: twice');
  check(sent.mentions.length === 2 && sent.mentions.every((m) => m === `@${bob.name}`), `and mentions @${bob.name} twice`);
  await shot(a, 'sent');
  console.log('OK');
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
