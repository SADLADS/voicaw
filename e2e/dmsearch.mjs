// Searching encrypted chats on the device (services/searchIndex.js): a DM's first search reads
// the history (progress shown), finds an old message, Jump loads older history to it; from:,
// has:, no in:; the second search reads only what's new; a deleted message drops out; the copy
// in IndexedDB has no readable text; notes; a group DM on a phone; Settings → Privacy's
// "Keep a search copy" off deletes the copy and searches still work.
//   node e2e/serve.mjs &   then   node e2e/dmsearch.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const resultTexts = (page) => page.locator('.search-panel .search-result .dm-message-content').allTextContents();
const panelTitle = (page) => page.locator('.search-panel .pins-panel-header h5').textContent();

// Counts the history pages the page asks the server for.
function countPages(page) {
  const counter = { pages: 0 };
  page.on('request', (r) => {
    if (/\/api\/(dm-messages\/\d+|group-dms\/[^/]+\/messages)(\?|$)/.test(r.url()) && r.method() === 'GET') counter.pages += 1;
  });
  return counter;
}

async function searchFor(page, text) {
  const input = page.locator('.guild-search-input');
  await input.fill('');
  await input.type(text);
  // The last search's results go as soon as the new one starts.
  await page.evaluate(() => document.querySelectorAll('.search-panel .search-result, .search-panel .pins-panel-empty, .search-panel .error-text').forEach((el) => el.classList.add('e2e-old')));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.search-panel .e2e-old'), null, { timeout: 10000 });
  await page.locator('.search-panel').waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.search-panel');
    return panel && !/Searching…|Reading the history/.test(panel.textContent) &&
      panel.querySelector('.search-result, .pins-panel-empty, .error-text');
  }, null, { timeout: 60000 });
}

// The search box (or the phone's button) is the last thing in the chat header, at its right end.
const searchAtRight = (page) => page.evaluate(() => {
  const header = document.querySelector('.chat-recipient-header');
  const search = header.querySelector('.guild-search, .search-button').getBoundingClientRect();
  const buttons = [...header.querySelectorAll('.chat-call-button')].map((b) => b.getBoundingClientRect());
  return buttons.every((b) => b.right <= search.left) && header.getBoundingClientRect().right - search.right < 24;
});

const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message));
  }

  console.log('a DM with a long history');
  await openChat(b, alice.id);
  await send(b, 'the treasure map is under the old oak');
  await send(b, 'menu at https://example.com/menu');
  await b.locator('.dm-message-content', { hasText: 'example.com/menu' }).waitFor();
  for (let i = 1; i <= 130; i++) await send(b, `chatter ${i}`);
  await b.locator('.dm-message-content', { hasText: /^chatter 130$/ }).waitFor({ timeout: 30000 });

  await openChat(a, bob.id);
  await a.locator('.dm-message-content', { hasText: /^chatter 130$/ }).waitFor();
  check(await searchAtRight(a), 'the search box is at the right end of the DM header');
  const pages = countPages(a);
  const box = a.locator('.guild-search-input');
  await box.click();
  const keys = await a.locator('.guild-search-suggestion strong').allTextContents();
  check(keys.join(' ') === 'from: mentions: has:', `the filters are from:, mentions:, has: (${keys.join(' ')})`);
  await box.type('has:');
  const hasValues = await a.locator('.guild-search-suggestion').allTextContents();
  check(!hasValues.includes('embed') && hasValues.includes('link'), `has: offers no embed (${hasValues.join(', ')})`);

  // Watch for the progress line while the history is read.
  const sawProgress = a.waitForFunction(() => /Reading the history/.test(document.querySelector('.search-panel')?.textContent ?? ''), null, { timeout: 30000 }).then(() => true, () => false);
  await searchFor(a, 'treas');
  check(await sawProgress, 'the first search shows it reading the history');
  check((await resultTexts(a)).join('|') === 'the treasure map is under the old oak', 'finds the old message by a word start');
  check(await panelTitle(a) === '1 result', 'one result');
  const firstPages = pages.pages;
  check(firstPages >= 2, `read the history in pages (${firstPages})`);
  await shot(a, '01-dm-result');

  check(!(await a.locator('.message-scroller .dm-message-content', { hasText: 'treasure map' }).count()), 'the message is not loaded in the chat yet');
  await a.locator('.search-result .pinned-message-jump').click();
  const target = a.locator('.message-scroller .each-dm-message-wrapper', { has: a.locator('.dm-message-content', { hasText: 'treasure map' }) });
  await target.waitFor({ timeout: 20000 });
  check(await target.evaluate((el) => el.classList.contains('jump-highlight')), 'Jump loads older history to it and flashes it');
  await shot(a, '02-jumped');

  await searchFor(a, 'has:link');
  check((await resultTexts(a)).join('|') === 'menu at https://example.com/menu', 'has:link');
  await searchFor(a, `from:${alice.name} chatter`);
  check(await a.locator('.pins-panel-empty').count() === 1, 'from:alice finds none of bob\'s');
  await searchFor(a, `from:${bob.name} "chatter 13"`);
  check((await resultTexts(a)).join('|') === 'chatter 13', 'a quoted phrase is exact');
  await searchFor(a, 'chatter');
  check(await panelTitle(a) === '130 results', '130 results');
  check(await a.locator('.search-result').count() === 25, 'a page of 25');
  await a.locator('.search-panel-more').click();
  await a.waitForFunction(() => document.querySelectorAll('.search-result').length === 50);
  check(true, 'Load more adds 25');
  await a.locator('.search-panel-sort-buttons button', { hasText: 'Oldest' }).click();
  await a.waitForFunction(() => document.querySelector('.search-result .dm-message-content')?.textContent === 'chatter 1');
  check(true, 'Oldest first');

  console.log('only what changed is read again');
  const before = pages.pages;
  // Bob deletes the old message, the conversation's first (through the API: it's far up his chat).
  await b.evaluate(async (other) => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
    let oldest = null;
    let first = null;
    for (;;) {
      const page = await (await fetch(`/api/dm-messages/${other}?limit=100${oldest ? `&before=${oldest}` : ''}`, { headers })).json();
      if (!page.length) break;
      [first] = page;
      oldest = first.id;
    }
    const res = await fetch(`/api/messages/${first.id}`, { method: 'DELETE', headers });
    if (!res.ok) throw new Error(`delete: ${res.status}`);
  }, alice.id);
  await searchFor(a, 'treasure');
  check(await a.locator('.pins-panel-empty').count() === 1, 'the deleted message is gone from the results');
  check(pages.pages - before <= 3, `the second search read ${pages.pages - before} page(s), not the history`);
  await searchFor(a, 'chatter');
  check(await panelTitle(a) === '130 results', 'the rest of the range read again is still found');

  const stored = await a.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('voicaw-search'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const all = await new Promise((resolve) => { db.transaction('segments').objectStore('segments').getAll().onsuccess = (e) => resolve(e.target.result); });
    db.close();
    const text = all.map((s) => new TextDecoder().decode(s.data)).join('');
    return { count: all.length, readable: /chatter|menu|treasure/.test(text) };
  });
  check(stored.count >= 1 && !stored.readable, `the copy on the device is ${stored.count} encrypted segment(s), nothing readable`);
  check(!JSON.stringify(await a.evaluate(() => ({ ...localStorage }))).includes('chatter'), 'nothing in localStorage');

  console.log('notes');
  await a.goto(`${BASE}/dm/notes`);
  await a.waitForSelector('#dm-input');
  await send(a, 'remember the milk');
  await a.locator('.dm-message-content', { hasText: 'remember the milk' }).waitFor();
  await searchFor(a, 'milk');
  check((await resultTexts(a)).join('|') === 'remember the milk', 'notes are searchable');
  check(await searchAtRight(a), 'and of the notes header');
  await shot(a, '03-notes');

  console.log('group DM on a phone');
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Picnic');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupUrl = a.url();
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await send(a, 'bring sandwiches please');
  await send(a, 'and a blanket');
  await a.locator('.dm-message-content', { hasText: 'and a blanket' }).waitFor();
  await c.goto(groupUrl);
  await c.locator('.dm-message-content', { hasText: 'and a blanket' }).waitFor({ timeout: 20000 });
  check(await searchAtRight(a), 'and of the group header');
  await shot(a, '03b-group-header');
  check(await searchAtRight(c), "the phone's search button is at the right end of the group header");
  await shot(c, '03c-phone-header');
  await c.locator('.channel-header-button.search-button').click();
  await c.locator('.search-panel.mobile').waitFor();
  check(/narrow it down with from:, mentions: and has:/.test(await c.locator('.search-panel').textContent()), 'the phone panel explains it');
  await shot(c, '04-phone-empty');
  await c.locator('.guild-search-input').type('sandw');
  await c.locator('.guild-search-input').press('Enter');
  await c.waitForFunction(() => document.querySelector('.search-panel .search-result, .search-panel .error-text'), null, { timeout: 30000 });
  check((await resultTexts(c)).join('|') === 'bring sandwiches please', 'a group message is found on the phone');
  const fits = await c.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(fits, 'the panel fits the phone');
  await shot(c, '05-phone-result');
  await c.locator('.search-result .pinned-message-jump').click();
  await c.locator('.search-panel').waitFor({ state: 'detached' });
  check(true, 'Jump closes the phone panel');

  console.log('no copy kept');
  await a.goto(`${BASE}/settings`);
  await a.getByText('Privacy & Safety').first().click();
  const keep = a.getByLabel('Keep a search copy on this device');
  check(await keep.isChecked(), 'Keep a search copy is on by default');
  await keep.uncheck();
  await a.waitForFunction(async () => !(await indexedDB.databases()).some((d) => d.name === 'voicaw-search'));
  check(true, 'turning it off deletes the copy');
  await shot(a, '06-privacy');
  await openChat(a, bob.id);
  const pagesBefore = pages.pages;
  await searchFor(a, 'chatter 12');
  check((await resultTexts(a))[0] === 'chatter 129', 'still searches with the setting off');
  check(pages.pages - pagesBefore >= 2, 'reading the whole history again');
  const dbs = await a.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  check(!dbs.includes('voicaw-search'), 'and keeps no copy');
  console.log('dmsearch: all good');
} finally {
  await browser.close();
}
