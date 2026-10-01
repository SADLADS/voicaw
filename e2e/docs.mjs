// Document channels in a real browser: Alice makes one and writes a document in the editor
// (markdown typed as in a message, toolbar bold, a checklist, a table, a cover image), publishes
// it; Bob sees its card (cover, title, excerpt) live, opens it, reacts and replies in its
// thread, which Alice sees live with the card's reply count. Bob can't edit Alice's; Alice
// edits and Bob's open page follows. Then a phone: Document / Replies tabs, nothing wider
// than the screen.
//   node e2e/serve.mjs &   then   node e2e/docs.mjs [screenshot dir]
import zlib from 'zlib';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// A `width`×`height` PNG, a left-to-right gradient (a stand-in cover photo).
function gradientPng(width, height) {
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
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) row.push(Math.round((x / width) * 255), 90, Math.round((y / height) * 255));
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const imageShown = (page, selector) => page.waitForFunction(
  (sel) => { const img = document.querySelector(sel); return img && img.complete && img.naturalWidth > 0; },
  selector,
  { timeout: 10000 },
);

// Fails if anything on the page is wider than the window (sideways scrolling).
async function noOverflow(page, where) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) throw new Error(`${where}: page is ${wide}px wider than the screen`);
}

// A key that only moves the selection, then a moment for the editor to notice (ProseMirror
// reads it from the browser's selectionchange event, which a script's next key can beat).
async function move(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(100);
}

const browser = await launchChrome();
const pages = [];
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  pages.push(['alice', a], ['bob', b]);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Writers');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');

  // A document channel.
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.check('input[name="channel-type"][value="doc"]');
  await a.fill('#channel-name', 'Handbook');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.click('.guild-channel-link:has-text("handbook")');
  await a.waitForSelector('.document-feed');
  await b.click('.guild-channel-link:has-text("handbook")');
  await b.waitForSelector('.document-empty');
  console.log('document channel made; both on its feed');

  // Alice writes one.
  await a.click('button:has-text("New document")');
  await a.waitForSelector('.doc-editor-text');
  await a.fill('textarea[aria-label="Title"]', 'Welcome to the team');
  await a.setInputFiles('input[aria-label="Cover image file"]', { name: 'cover.png', mimeType: 'image/png', buffer: gradientPng(900, 300) });
  await imageShown(a, '.doc-editor-cover .document-cover img');
  await a.click('.doc-editor-text');
  await a.keyboard.type('# Getting started');
  await a.keyboard.press('Enter');
  await a.keyboard.type('Read this **first** and ask questions in the replies.');
  await a.keyboard.press('Enter');
  await a.keyboard.type('- [ ] Set up your laptop');
  await a.keyboard.press('Enter');
  await a.keyboard.type('Meet the team');
  await a.keyboard.press('Enter');
  await a.keyboard.press('Enter');
  await a.keyboard.type('Important');
  await move(a, 'Shift+Home');
  await a.click('button[aria-label="Bold"]');
  await move(a, 'End');
  await a.keyboard.press('Enter');
  await a.click('button[aria-label="Insert table"]');
  await a.keyboard.type('Who');
  await a.keyboard.press('Tab');
  await a.keyboard.type('Role');
  await a.keyboard.press('Tab');
  await a.keyboard.type('Alice');
  await a.keyboard.press('Tab');
  await a.keyboard.type('Lead');
  await shot(a, 'editor');
  // The toolbar knows where the cursor is.
  if (!(await a.isVisible('.doc-table-tools'))) throw new Error('no table tools inside a table');

  await a.click('button:has-text("Publish")');
  await a.waitForSelector('.document-page h1.document-title:has-text("Welcome to the team")');
  const rendered = await a.evaluate(() => {
    const body = document.querySelector('.document-page-inner .document-body');
    return {
      h1: body.querySelector('h1')?.textContent,
      bold: [...body.querySelectorAll('strong')].map((s) => s.textContent),
      checkbox: Boolean(body.querySelector('li input[type="checkbox"]')),
      cells: [...body.querySelectorAll('td, th')].map((c) => c.textContent),
    };
  });
  const want = { h1: 'Getting started', bold: ['first', 'Important'], checkbox: true, cells: ['Who', 'Role', 'Alice', 'Lead', '', '', '', '', ''] };
  if (JSON.stringify(rendered) !== JSON.stringify(want)) throw new Error(`rendered ${JSON.stringify(rendered)}`);
  await imageShown(a, '.document-page-cover img');
  await shot(a, 'document');
  console.log('published; renders heading, bold, checklist, table, cover');

  // Bob's feed shows it live.
  await b.waitForSelector('.document-card-title:has-text("Welcome to the team")');
  await imageShown(b, '.document-card-cover img');
  const excerpt = await b.textContent('.document-card-excerpt');
  if (!excerpt.startsWith('Getting started Read this first')) throw new Error(`excerpt "${excerpt}"`);
  await shot(b, 'feed');
  console.log('bob: card live with cover and excerpt');

  // Bob opens it, can't edit, reacts and replies.
  await b.click('button[aria-label="Open Welcome to the team"]');
  await b.waitForSelector('.document-page h1.document-title');
  if (await b.isVisible('.document-page-actions button:has-text("Edit")')) throw new Error('bob can edit alice\'s document');
  await b.click('button.document-react');
  await b.fill('.emoji-picker input', 'thumbs up');
  await b.click('.emoji-picker-item[aria-label="Thumbs Up Sign"], .emoji-picker-item >> nth=0');
  await b.waitForSelector('.document-reactions .reaction-chip.mine');
  await b.click('.document-replies #dm-input');
  await b.keyboard.type('Thanks, very useful!');
  await b.keyboard.press('Enter');
  await b.waitForSelector('.document-replies .dm-message-content:has-text("Thanks, very useful!")');
  console.log('bob: reacted and replied');

  await a.waitForSelector('.document-reactions .reaction-chip:not(.mine)');
  await a.waitForSelector('.document-replies .dm-message-content:has-text("Thanks, very useful!")');
  await shot(a, 'document-with-reply');
  // With a reaction there, the page still offers adding another (not only on hover).
  if (await a.$eval('.document-page .document-reactions .reaction-add', (el) => getComputedStyle(el).opacity) !== '1') throw new Error('document + hidden');
  console.log('alice: reaction and reply live');

  // Alice edits; Bob's open page follows.
  await a.click('.document-page-actions button:has-text("Edit")');
  await a.waitForSelector('.doc-editor-text h1');
  await a.click('.doc-editor-text h1');
  await move(a, 'End');
  await a.keyboard.type(' quickly');
  await a.click('button:has-text("Save")');
  await a.waitForSelector('.document-page-inner .document-body h1:has-text("Getting started quickly")');
  await b.waitForSelector('.document-page-inner .document-body h1:has-text("Getting started quickly")');
  console.log('edited; bob\'s page followed');

  // Back on the feed, the card counts the reply.
  await a.click('button[aria-label="All documents"]');
  await a.waitForSelector('.document-card-replies:has-text("1 reply")');
  console.log('feed: 1 reply');

  // Reacting from the card, without opening the document: Alice adds to Bob's 👍, then picks
  // another; Bob's feed follows.
  const docUrl = new URL(b.url());
  await b.click('button[aria-label="All documents"]');
  await b.waitForSelector('.document-card');
  await a.click('.document-card .reaction-chip:not(.reaction-add):not(.mine)');
  await a.waitForSelector('.document-card .reaction-chip.mine .reaction-count:has-text("2")');
  // The add button shows while the card is hovered.
  await a.hover('.document-card');
  if (await a.$eval('.document-card .reaction-add', (el) => getComputedStyle(el).opacity) !== '1') throw new Error('card + hidden on hover');
  await a.click('.document-card .reaction-add');
  await a.fill('.emoji-picker input', 'heart');
  await a.click('.emoji-picker-item >> nth=0');
  await a.waitForFunction(() => document.querySelectorAll('.document-card .reaction-chip.mine').length === 2);
  if (new URL(a.url()).searchParams.get('doc')) throw new Error('reacting on a card opened the document');
  await b.waitForFunction(() => document.querySelectorAll('.document-card .reaction-chip:not(.reaction-add)').length === 2);
  // New document is the app's accent colour, not Bootstrap's blue.
  const newDocColor = await a.$eval('.document-feed-header .btn', (el) => getComputedStyle(el).backgroundColor);
  if (newDocColor === 'rgb(13, 110, 253)') throw new Error('New document is Bootstrap blue');
  await shot(a, 'feed-reactions');
  console.log('feed: reacted from the card; bob\'s card followed');

  // A phone: tabs, nothing wider than the screen.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  p.on('pageerror', (e) => console.log('[phone] page error:', e.message));
  await p.goto(`${BASE}/`);
  await p.evaluate((token) => localStorage.setItem('token', token), await b.evaluate(() => localStorage.getItem('token')));
  await p.goto(`${BASE}${docUrl.pathname}${docUrl.search}`);
  await p.waitForSelector('.document-page h1.document-title');
  await imageShown(p, '.document-page-cover img');
  await noOverflow(p, 'phone document');
  await shot(p, 'phone-document');
  await p.click('.document-tabs button:has-text("Replies")');
  await p.waitForSelector('.document-replies .dm-message-content:has-text("Thanks, very useful!")');
  await noOverflow(p, 'phone replies');
  await shot(p, 'phone-replies');
  await p.click('button[aria-label="All documents"]');
  await p.waitForSelector('.document-card');
  await noOverflow(p, 'phone feed');
  await shot(p, 'phone-feed');
  console.log('phone: document, replies tab, feed fit the screen');

  console.log('docs e2e: ok');
} catch (err) {
  console.error('docs e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  for (const [name, page] of pages) await shot(page, `failed-${name}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
