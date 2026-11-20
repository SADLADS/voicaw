// History imports in a real browser (docs/guilds.md, History imports): the owner picks a made-up
// exported archive (a folder: one channel's JSON and its media folder) in Guild Settings →
// Import, the author with Bob's name is suggested as Bob, the channel goes into #general (which
// already has a message), the tag reads "Discord"; it's sent with its files. Then #general holds
// the old messages in date order before the live one, each with the tag and its note, the
// unlinked author with the archive's picture, a picture from the media folder, a file that
// wasn't included, the archive's reactions; nothing is unread for Bob. A reply's snippet jumps
// to a message far back (the page around it, Jump to present back). Bob, on a phone, says
// "This wasn't me" and his messages go back to the archive's name; Settings → Privacy →
// Imported messages lists nothing then. The tag in every theme. Also (2026-11-19): a file the
// archive only links to on the old CDN is downloaded by the browser (the CDN stood in for by a
// Playwright route) and one whose link expired isn't tried; the archive's custom emoji, one
// added to the guild from the media folder ("Add all the others"), one left as text; a message
// that's only a Tenor GIF link shows the GIF and not the link (needs the internet: the server
// reads tenor.com's page).
//   node e2e/serve.mjs &   then   node e2e/history-import.mjs [screenshot dir]
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'X-Voicaw-Session': JSON.parse(localStorage.getItem('login')).sid, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, path, body]);

// The archive, as the exporter writes it with its media option: one JSON per channel, files
// beside it in "<name>.json_Files", referred to by relative paths.
async function makeArchive(bobName) {
  const dir = mkdtempSync(join(tmpdir(), 'voicaw-e2e-import-'));
  const root = join(dir, 'Old Crew export');
  const json = 'Old Crew - general [9].json';
  const files = `${json}_Files`;
  mkdirSync(join(root, files), { recursive: true });
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#e07a2e' } }).png().toFile(join(root, files, 'sunset-1A2B.png'));
  await sharp({ create: { width: 128, height: 128, channels: 3, background: '#2e7de0' } }).png().toFile(join(root, files, 'kestrel-av.png'));
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3ec46d' } }).png().toFile(join(root, files, 'blobwave-7001.png'));
  const exHex = (ms) => Math.floor(ms / 1000).toString(16);
  const cdn = (name, expires) => `https://cdn.discordapp.com/attachments/9/1/${name}?ex=${exHex(expires)}&is=0&hm=ff`;
  const person = (id, name, nickname, avatarUrl = `https://cdn.example/avatars/${id}.png`, isBot = false) => ({ id, name, discriminator: '0000', nickname, color: null, isBot, avatarUrl });
  const sam = person('111', bobName, 'Sam');
  const kestrel = person('222', 'kestrel99', null, `${files}/kestrel-av.png`);
  const botto = person('333', 'botto', 'Botto', undefined, true);
  const at = (minutes) => new Date(Date.UTC(2024, 2, 12, 20, 0) + minutes * 60_000).toISOString();
  const msg = (id, author, minutes, extra = {}) => ({
    id: String(id), type: 'Default', timestamp: at(minutes), timestampEdited: null, callEndedTimestamp: null, isPinned: false,
    content: '', author, attachments: [], embeds: [], stickers: [], reactions: [], mentions: [], inlineEmojis: [], ...extra,
  });
  const messages = [
    msg(1000, sam, 0, { content: 'the very first message, zebra' }),
    msg(1001, kestrel, 1, {
      content: 'anyone up for raids tonight? @Sam', mentions: [sam],
      reactions: [{ emoji: { id: '', name: '🔥', code: 'fire' }, count: 2, users: [sam, kestrel] }],
    }),
    msg(1002, sam, 2, { content: 'look at this', attachments: [{ id: 'a', url: `${files}/sunset-1A2B.png`, fileName: 'sunset.png', fileSizeBytes: 1000 }] }),
    msg(1003, kestrel, 3, { content: 'lost one', attachments: [{ id: 'b', url: 'https://cdn.example/attachments/9/1/gone.gif?ex=1', fileName: 'gone.gif', fileSizeBytes: 324843 }] }),
    msg(1004, botto, 4, { type: '20', content: "Sam's score is 8", interaction: { id: 'i', name: 'score', user: sam } }),
    msg(1005, kestrel, 5, { content: 'from the cdn', attachments: [{ id: 'c', url: cdn('remote.png', Date.now() + 3_600_000), fileName: 'remote.png', fileSizeBytes: 900 }] }),
    msg(1006, kestrel, 6, { content: 'too late', attachments: [{ id: 'd', url: cdn('stale.png', Date.now() - 3_600_000), fileName: 'stale.png', fileSizeBytes: 900 }] }),
    msg(1007, sam, 7, {
      content: 'wave hello :blobwave: :nope:',
      inlineEmojis: [
        { id: '7001', name: 'blobwave', code: 'blobwave', isAnimated: false, imageUrl: `${files}/blobwave-7001.png` },
        { id: '7002', name: 'nope', code: 'nope', isAnimated: false, imageUrl: 'https://cdn.example/emojis/7002.png' },
      ],
    }),
    msg(1008, sam, 8, { content: TENOR }),
  ];
  // Enough after them that the first is more than a page back.
  for (let i = 0; i < 200; i += 1) messages.push(msg(2000 + i, i % 2 ? sam : kestrel, 10 + i, { content: `old chatter ${i}` }));
  messages.push(msg(3000, kestrel, 500, { type: 'Reply', content: 'remember the first one?', reference: { type: 'Default', messageId: '1000', channelId: '9' } }));
  writeFileSync(join(root, json), JSON.stringify({
    guild: { id: '1', name: 'Old Crew' },
    channel: { id: '9', type: 'GuildTextChat', categoryId: '8', category: 'public', name: 'general', topic: null },
    dateRange: { after: null, before: null }, exportedAt: new Date().toISOString(),
    messages, messageCount: messages.length,
  }));
  return { dir, root };
}

const TENOR = 'https://tenor.com/view/maxzijah-olandamaxz-gitapro3-gitapro1-gitajah13-gif-2819219459901095368';

const browser = await launchChrome();
let archive;
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'New home');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildId = new URL(a.url()).pathname.split('/')[2];
  const general = (await call(a, 'GET', `/guilds/${guildId}`)).body.channels.find((c) => c.name === 'general');
  await call(a, 'POST', `/channels/${general.id}/messages`, { content: 'hello from now' });

  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const b = bob.page;
  const invite = await call(a, 'POST', `/guilds/${guildId}/invites`, {});
  await b.goto(`${BASE}/invite/${invite.body.code}`);
  await b.click('.invite-card button:has-text("Accept invite")');
  await b.waitForURL(/\/guild\/\d+/, { timeout: 10000 });
  const unreadBefore = (await call(b, 'GET', '/guild-unread')).body;

  archive = await makeArchive(bob.name);

  // Guild Settings → Import.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.click('.guild-settings-nav .settings-nav-item:has-text("Import")');
  // The old CDN, stood in for: the browser downloads a linked file from it.
  const cdnAsked = [];
  const remotePng = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#a03ee0' } }).png().toBuffer();
  await a.route('https://cdn.discordapp.com/**', (route) => {
    cdnAsked.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: remotePng });
  });
  await a.click('button:has-text("Import history")');
  await a.setInputFiles('input[webkitdirectory]', archive.root);
  await a.waitForSelector('.guild-import-summary');
  const summary = await a.textContent('.guild-import-summary');
  check(summary.includes('“Old Crew”') && summary.includes('210 messages'), `the archive is read (${summary})`);
  check(summary.includes('1 of 4 files') && summary.includes('1 more is only linked') && summary.includes('1 has a link that has expired'), 'one file in the archive, one to download, one expired, one not included');
  check(await a.isChecked('.guild-import-check input'), 'downloading linked files is on by default');
  await shot(a, '01-picked');
  await a.click('.guild-import button:has-text("Next")');
  await a.waitForSelector('.guild-import-row');
  const channelChoice = await a.$eval('select[aria-label="Where #general goes"]', (s) => s.selectedOptions[0].textContent);
  check(channelChoice === '#general', 'the archive channel goes into #general (same name)');
  const samChoice = await a.$eval(`select[aria-label="Who Sam is"]`, (s) => s.selectedOptions[0].textContent);
  check(samChoice.includes(bob.name), "the author with Bob's name is suggested as Bob");
  // Custom emoji: none of the guild's yet, so both start as text; Add all the others adds the one
  // with a picture (the media folder), the other has nothing to add.
  check(await a.$eval('select[aria-label="What :blobwave: becomes"]', (s) => s.value) === 'text', 'an emoji the guild lacks starts as text');
  check(await a.locator('select[aria-label="What :nope: becomes"] option[value="add"]').count() === 0, "an emoji without a picture can't be added");
  check(await a.locator('.guild-import-row:has-text(":blobwave:") img.guild-import-emoji').count() === 1, "the emoji's picture from the archive is shown");
  await a.click('button:has-text("Add all the others to this guild")');
  check(await a.$eval('select[aria-label="What :blobwave: becomes"]', (s) => s.value) === 'add', 'Add all the others picks Add for it');
  await a.fill('.guild-import-label input', 'Discord');
  check((await a.textContent('.guild-import-preview .import-tag-label')) === 'Discord', 'the preview shows the label');
  await shot(a, '02-mapping');
  await a.click('.guild-import button:has-text("Import 210 messages")');
  await a.waitForSelector('.guild-import-heading:has-text("Imported")', { timeout: 60000 });
  check((await a.textContent('.guild-import p[role="status"]')).includes('210 of 210'), 'all messages sent');
  check(cdnAsked.length === 1 && cdnAsked[0].includes('/remote.png'), `only the live link was downloaded (${cdnAsked.length})`);
  const emojis = (await call(a, 'GET', `/guilds/${guildId}/emojis`)).body;
  check(emojis.length === 1 && emojis[0].name === 'blobwave', 'the emoji was added to the guild');
  await shot(a, '03-done');
  await a.click('.guild-import button:has-text("Done")');
  await a.waitForSelector('.guild-import-item');
  check((await a.textContent('.guild-import-item')).includes('Done'), 'listed under Past imports as done');
  await a.keyboard.press('Escape');

  // #general: the newest page, the live message last.
  await a.waitForSelector('.import-tag', { timeout: 10000 });
  const texts = await a.$$eval('.dm-message-content', (els) => els.map((e) => e.textContent.trim()));
  check(texts[texts.length - 1] === 'hello from now', 'the live message stays the newest');
  check(texts[texts.length - 2] === 'remember the first one?', 'imported messages come before it, by date');
  check(!(await a.$$eval('.dm-message-content', (els) => els.some((e) => e.textContent.trim() === 'the very first message, zebra'))), 'the oldest is more than a page back');
  // The reply's snippet jumps to the first message: the page around it, then Jump to present.
  await a.click('.reply-preview:has-text("the very first message")');
  await a.waitForSelector('.jump-to-present', { timeout: 10000 });
  const contents = () => a.$$eval('.dm-message-content', (els) => els.map((e) => e.textContent.trim()));
  check((await contents())[0] === 'the very first message, zebra', 'jumped to the first imported message (the page around it)');
  const inView = await a.$eval('[data-msg-id]:has(> .dm-message .dm-message-content)', (row) => {
    const box = row.getBoundingClientRect();
    const list = row.closest('.message-scroller').getBoundingClientRect();
    return box.bottom > list.top && box.top < list.bottom;
  });
  check(inView, 'and it is on screen');
  await shot(a, '04-jumped');
  const first = a.locator('.each-dm-message-wrapper:has-text("the very first message")');
  check((await first.locator('.message-author').textContent()) === bob.name, 'a linked author shows as the member');
  check((await first.locator('.imported-as').textContent()) === 'as Sam', "with the archive's name beside the tag");
  // The other messages near the start.
  await a.hover('.each-dm-message-wrapper:has-text("anyone up for raids") .import-tag');
  const note = await a.textContent('.each-dm-message-wrapper:has-text("anyone up for raids") .import-tag-popover');
  check(note.includes('From #general in “Old Crew”.') && note.includes("can't confirm"), `the tag's note (${note})`);
  check(await a.locator('.each-dm-message-wrapper:has-text("anyone up for raids") .imported-reaction').count() === 1, "the archive's reaction");
  const avatar = await a.getAttribute('.each-dm-message-wrapper:has-text("anyone up for raids") img.message-avatar', 'src');
  check(avatar?.includes('/profile-pics/imports/'), "the unlinked author's picture from the archive, stored by us");
  check(await a.locator('.each-dm-message-wrapper:has-text("look at this") img[src*="/uploads/imports/"]').count() === 1, 'the picture from the media folder');
  check((await a.textContent('.each-dm-message-wrapper:has-text("lost one")')).includes('gone.gif'), 'the file not included is named');
  check((await a.textContent('.each-dm-message-wrapper:has-text("score is 8")')).includes('/score'), 'the command line');
  check(await a.locator('.each-dm-message-wrapper:has-text("from the cdn") img[src*="/uploads/imports/"]').count() === 1, 'the downloaded file is ours now');
  check((await a.textContent('.each-dm-message-wrapper:has-text("too late")')).includes('stale.png'), 'the expired one is named as not included');
  const waved = a.locator('.each-dm-message-wrapper:has-text("wave hello")');
  check(await waved.locator(`img.custom-emoji[src*="/emojis/${emojis[0].id}"]`).count() === 1, 'the added emoji shows in the message');
  check((await waved.locator('.dm-message-content').textContent()).includes(':nope:'), 'the other stays as text');
  // The Tenor link: the server reads its page (the internet), then the GIF replaces the link.
  const gifRow = a.locator(`.each-dm-message-wrapper:has(img[src*="tenor.com"])`);
  await gifRow.first().waitFor({ timeout: 30000 });
  check(!(await gifRow.first().textContent()).includes('tenor.com/view'), "a Tenor link alone shows its GIF, not the link");
  await gifRow.first().scrollIntoViewIfNeeded();
  await shot(a, '05a-gif-and-emoji');
  await shot(a, '05-tag-note');
  for (const theme of ['light', 'familiar', 'halloween', 'christmas', 'slack']) {
    await a.evaluate((t) => localStorage.setItem('theme', t), theme);
    await a.reload();
    await a.waitForSelector('.import-tag');
    await a.hover('.message-scroller .import-tag >> nth=-1');
    await shot(a, `06-theme-${theme}`);
  }
  await a.evaluate(() => localStorage.setItem('theme', 'dark'));
  await a.reload();
  await a.waitForSelector('.import-tag');
  await a.click('.jump-to-present button').catch(() => {});

  check(JSON.stringify((await call(b, 'GET', '/guild-unread')).body) === JSON.stringify(unreadBefore), 'nothing became unread for Bob');

  // Bob on a phone: his imported message, "This wasn't me".
  await b.goto(`${BASE}/guild/${guildId}/${general.id}`);
  await b.waitForSelector('.import-tag', { timeout: 10000 });
  const mine = b.locator('.each-dm-message-wrapper:has(.imported-as) >> nth=-1');
  await mine.scrollIntoViewIfNeeded();
  await b.locator('.each-dm-message-wrapper:has(.imported-as) .import-tag >> nth=-1').tap();
  check(await b.locator('.import-tag-popover:visible').count() >= 1, "a tap shows the tag's note on a phone");
  const box = await b.locator('.import-tag-popover:visible').first().boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 412 + 1, 'the note fits the phone');
  await shot(b, '07-phone-note');
  const cdp = await b.context().newCDPSession(b);
  const text = await mine.locator('.dm-message-content').boundingBox();
  const touch = { x: text.x + 20, y: text.y + 5 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await b.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await b.click('.action-sheet-item:has-text("This wasn\'t me")');
  await b.click('.vc-dialog button:has-text("Unlink me")');
  await b.waitForFunction(() => !document.querySelector('.imported-as'), null, { timeout: 10000 });
  check(true, "after This wasn't me, no message shows as Bob's");
  await b.waitForSelector('.import-tag', { timeout: 10000 });
  const names = await b.$$eval('.message-author', (els) => els.map((e) => e.textContent.trim()));
  check(names.includes('Sam') && !names.includes(bob.name), `they show the archive's name (${[...new Set(names)].join(', ')})`);
  await shot(b, '08-phone-unlinked');
  await b.goto(`${BASE}/settings/privacy#imported-messages`);
  await b.waitForSelector('text=No imported messages are linked to you.', { timeout: 10000 });
  check(true, 'Settings → Privacy → Imported messages lists nothing');
  await shot(b, '09-phone-settings');
  console.log('history-import: ok');
} catch (err) {
  console.error('history-import: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (archive) rmSync(archive.dir, { recursive: true, force: true });
}
