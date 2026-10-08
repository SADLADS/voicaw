// Our right-click menus where the browser's used to be (PageMenus), and our own spellcheck:
// the message box underlines misspelled words itself (browser's checker off there), right-click
// one for fixes and Add to Dictionary (saved encrypted: the server never has the word, and
// it's back after a reload), Cut / Copy / Paste / Select All, the Spellcheck toggle, a plain
// text box (a document's title) getting our suggestions, selected text (Copy), Shift for the
// browser's menu; a document's cover and its pictures (page and editor) get the picture menu,
// and on a phone holding the cover opens it as a sheet (Settings has no Spellcheck there).
//   node e2e/serve.mjs &   then   node e2e/textmenu.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import zlib from 'node:zlib';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const items = (page, sel = '.context-menu') => page.$$eval(`${sel} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A small solid PNG (a stand-in picture).
function png(width, height) {
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
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [60, 120, 200]).flat()]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const imageShown = (page, selector) => page.waitForFunction(
  (sel) => { const img = document.querySelector(sel); return img && img.complete && img.naturalWidth > 0; },
  selector,
  { timeout: 15000 },
);

async function rightClick(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.context-menu');
}

async function pick(page, label) {
  await page.click(`.context-menu [role^="menuitem"]:has-text("${label}")`);
  await page.waitForSelector('.context-menu', { state: 'detached' });
}

const editorText = (page) => page.$eval('#dm-input', (el) => el.textContent);
const underlined = (page, sel = '#dm-input') => page.$$eval(`${sel} .spelling-error`, (els) => els.map((e) => e.textContent));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const guild = await api(a, 'POST', '/guilds', { name: 'Words' });
  const general = guild.channels[0];
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(carol.page, 'POST', `/invites/${invite.code}`);

  // The message box: our underlines, the browser's off.
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.click('#dm-input');
  await a.keyboard.type('Hello wrold teh ');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input .spelling-error').length === 2, null, { timeout: 20000 });
  check(same(await underlined(a), ['wrold', 'teh']), 'the message box underlines its misspelled words');
  check(await a.$eval('#dm-input', (el) => el.getAttribute('spellcheck')) === 'false', "with the browser's own checker off there");
  await shot(a, '01-underlines');

  await rightClick(a, a.locator('#dm-input .spelling-error', { hasText: 'wrold' }));
  const fixes = await items(a);
  check(fixes[0] === 'world', `right-click offers fixes first: ${fixes.join(', ')}`);
  check(['Add to Dictionary', 'Paste', 'Select All', 'Spellcheck'].every((x) => fixes.includes(x)), 'then Add to Dictionary, Paste, Select All, Spellcheck');
  await shot(a, '02-menu');
  await pick(a, 'world');
  check((await editorText(a)).startsWith('Hello world teh'), 'picking one puts it in place');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input .spelling-error').length === 1);

  // Add to Dictionary: the underline goes, the server keeps it encrypted.
  await a.keyboard.press('End');
  await a.keyboard.type('Voicawish ');
  await a.waitForFunction(() => [...document.querySelectorAll('#dm-input .spelling-error')].some((e) => e.textContent === 'Voicawish'), null, { timeout: 10000 });
  await rightClick(a, a.locator('#dm-input .spelling-error', { hasText: 'Voicawish' }));
  await pick(a, 'Add to Dictionary');
  await a.waitForFunction(() => ![...document.querySelectorAll('#dm-input .spelling-error')].some((e) => e.textContent === 'Voicawish'));
  check(true, 'Add to Dictionary takes the underline away');
  await a.waitForFunction(async () => {
    const res = await fetch('/api/dictionary', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).version === 1;
  }, null, { timeout: 10000 });
  const saved = await api(a, 'GET', '/dictionary');
  check(saved.dictionary.startsWith('v1.') && !saved.dictionary.includes('Voicawish') && !atob(saved.dictionary.slice(3)).includes('Voicawish'), 'the server holds it encrypted (no word in it)');

  // Select All, Copy, Cut, Paste through the menu.
  await rightClick(a, a.locator('#dm-input'));
  await pick(a, 'Select All');
  await rightClick(a, a.locator('#dm-input'));
  check((await items(a)).includes('Cut') && (await items(a)).includes('Copy'), 'with text selected, Cut and Copy are offered');
  await pick(a, 'Copy');
  check((await a.evaluate(() => navigator.clipboard.readText())).startsWith('Hello world teh Voicawish'), 'Copy copies the selection');
  await rightClick(a, a.locator('#dm-input'));
  await pick(a, 'Cut');
  check((await editorText(a)).trim() === '', 'Cut empties the box');
  await a.evaluate(() => navigator.clipboard.writeText('pasted from the menu'));
  await rightClick(a, a.locator('#dm-input'));
  await pick(a, 'Paste');
  await a.waitForFunction(() => document.querySelector('#dm-input').textContent.includes('pasted from the menu'));
  check(true, 'Paste pastes into the message box');

  // Shift+right-click: the browser's own (not cancelled, ours not opened).
  const shiftCancelled = await a.$eval('#dm-input', (el) => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: true })));
  check(!shiftCancelled && await a.locator('.context-menu').count() === 0, "Shift+right-click leaves it to the browser's menu");

  // The Spellcheck toggle: off takes the underlines away.
  await a.keyboard.press('Control+a');
  await a.keyboard.type('Bad speling here ');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input .spelling-error').length === 1, null, { timeout: 10000 });
  await rightClick(a, a.locator('#dm-input'));
  await pick(a, 'Spellcheck');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input .spelling-error').length === 0);
  check(await a.evaluate(() => document.documentElement.spellcheck) === false, 'the Spellcheck toggle turns checking off');
  await rightClick(a, a.locator('#dm-input'));
  await pick(a, 'Spellcheck');
  await a.waitForFunction(() => document.querySelectorAll('#dm-input .spelling-error').length === 1, null, { timeout: 10000 });
  check(true, 'and back on');
  await a.keyboard.press('Control+a');
  await a.keyboard.press('Delete');

  // Selected text in a message: Copy.
  await api(a, 'POST', `/channels/${general.id}/messages`, { content: 'pick these words' });
  const message = a.locator('.dm-message-content', { hasText: 'pick these words' });
  await message.waitFor();
  await message.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await rightClick(a, message);
  check(same(await items(a), ['Copy']), 'selected text gets Copy');
  await a.click('.context-menu >> text=Copy');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  check((await a.evaluate(() => navigator.clipboard.readText())).includes('pick these words'), 'and it copies it');

  // Reload: the word comes back from the server (decrypted here), listed in Settings.
  await a.goto(`${BASE}/settings#spellcheck`);
  await a.waitForSelector('.spellcheck-words li', { timeout: 15000 });
  check(same(await a.$$eval('.spellcheck-words li span', (els) => els.map((e) => e.textContent)), ['Voicawish']), 'Settings → Spellcheck lists your words after a reload');
  check((await a.$$eval('#spellcheck-language option', (els) => els.map((e) => e.textContent))).includes('English (UK)'), 'with a language to choose');
  await a.locator('#settings-spellcheck').scrollIntoViewIfNeeded();
  await shot(a, '03-settings');

  // A document channel: the title (a plain text box) gets our suggestions; pictures get theirs.
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.check('input[name="channel-type"][value="doc"]');
  await a.fill('#channel-name', 'Handbook');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.click('.guild-channel-link:has-text("handbook")');
  await a.waitForSelector('.document-feed');
  await a.click('button:has-text("New document")');
  await a.waitForSelector('.doc-editor-text');
  const title = a.locator('textarea[aria-label="Title"]');
  await title.fill('Teh plan');
  // Right-click puts the caret where it's clicked, so the word is the one under the pointer.
  const titleBox = await title.boundingBox();
  await a.mouse.click(titleBox.x + 14, titleBox.y + titleBox.height / 2, { button: 'right' });
  await a.waitForSelector('.context-menu');
  const titleItems = await items(a);
  check(titleItems.includes('The') && titleItems.includes('Add to Dictionary'), `a plain text box gets our suggestions: ${titleItems.join(', ')}`);
  await pick(a, 'The');
  check(await title.inputValue() === 'The plan', 'and picking one replaces the word');

  await a.setInputFiles('input[aria-label="Cover image file"]', { name: 'cover.png', mimeType: 'image/png', buffer: png(600, 200) });
  await imageShown(a, '.doc-editor-cover .document-cover img');
  await a.click('.doc-editor-text');
  await a.keyboard.type('A picture: ');
  await a.setInputFiles('input[aria-label="Image file"]', { name: 'inside.png', mimeType: 'image/png', buffer: png(200, 120) });
  await imageShown(a, '.doc-editor-text img.doc-editor-image');
  await a.waitForFunction(() => !document.querySelector('.doc-editor-text img.doc-editor-image.loading'));
  await rightClick(a, a.locator('.doc-editor-text img.doc-editor-image'));
  check(same(await items(a), ['Copy Image', 'Save Image', 'Open Image']), 'a picture in the editor gets the picture menu');
  await a.keyboard.press('Escape');
  await rightClick(a, a.locator('.doc-editor-cover .document-cover img'));
  check(same(await items(a), ['Copy Image', 'Save Image', 'Open Image']), "and so does the editor's cover");
  await a.keyboard.press('Escape');
  await a.click('button:has-text("Publish")');
  await imageShown(a, '.document-page-cover img');
  await rightClick(a, a.locator('.document-page-cover img'));
  check(same(await items(a), ['Copy Image', 'Save Image', 'Open Image']), "the document's cover gets it");
  await a.click('.context-menu >> text=Copy Image');
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await a.waitForSelector('.context-menu', { state: 'detached' });
  await imageShown(a, '.document-page .document-body img');
  await rightClick(a, a.locator('.document-page .document-body img').first());
  check(same(await items(a), ['Copy Image', 'Save Image', 'Open Image']), 'and so does a picture in it');
  await shot(a, '04-doc-image-menu');
  await a.keyboard.press('Escape');
  const docUrl = a.url();

  // A phone: holding the cover opens the picture sheet; no Spellcheck in Settings.
  const p = carol.page;
  await p.goto(docUrl);
  await imageShown(p, '.document-page-cover img');
  const cover = await p.locator('.document-page-cover img').boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const point = { x: cover.x + cover.width / 2, y: cover.y + cover.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await p.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForSelector('.context-sheet');
  check(same(await items(p, '.context-sheet'), ['Copy Image', 'Save Image', 'Open Image']), 'on a phone, holding the cover opens its sheet');
  await p.waitForTimeout(300);
  await shot(p, '05-phone-sheet');
  await p.click('.action-sheet-backdrop', { position: { x: 10, y: 10 } });
  await p.goto(`${BASE}/settings/language`);
  await p.waitForSelector('#settings-language');
  check(await p.locator('#settings-spellcheck').count() === 0, 'and Settings has no Spellcheck on a phone');

  console.log('textmenu: all good');
} finally {
  await browser.close();
}
