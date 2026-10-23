// Live co-editing of documents in a real browser: Alice writes a document with "Others can
// edit" ticked; Bob (who can't delete it) edits it with her at the same time. Both type at
// once in different places, and in the same paragraph; both editors end with the same text,
// and the server's save has it. Each sees the other's picture in the bar and caret (with their
// name) in the text, following what the other types. Carol, only reading, sees the page change
// while they type. A title change reaches the other editor. Bob goes offline, types, comes back:
// his text arrives. Alice turns "Others can edit" off: Bob's editor stops. Then a phone editor
// fits the screen.
//   node e2e/serve.mjs &   then   node e2e/docslive.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function noOverflow(page, where) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) throw new Error(`${where}: page is ${wide}px wider than the screen`);
}

// A key that only moves the selection, then a moment for the editor to notice (see docs.mjs).
async function move(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(100);
}

// The editor's text without the other people's caret names.
const editorText = (page) => page.evaluate(() => {
  const copy = document.querySelector('.doc-editor-text').cloneNode(true);
  copy.querySelectorAll('.collab-caret').forEach((c) => c.remove());
  return [...copy.children].map((block) => block.textContent).join('\n');
});

const saved = (page) => page.waitForSelector('.doc-editor-status:has-text("All changes saved")', { timeout: 15000 });

const browser = await launchChrome();
const pages = [];
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  pages.push(['alice', a], ['bob', b], ['carol', c]);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Planners');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = (await a.inputValue('#invite-link')).replace(/^https?:\/\/[^/]+/, BASE);
  await a.keyboard.press('Escape');
  for (const p of [b, c]) {
    await p.goto(link);
    await p.click('button:has-text("Accept invite")');
    await p.waitForSelector('#dm-input');
  }
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.check('input[name="channel-type"][value="doc"]');
  await a.fill('#channel-name', 'Plans');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.click('.guild-channel-link:has-text("plans")');
  await a.waitForSelector('.document-feed');

  // Alice writes it, open to everyone's editing.
  await a.click('button:has-text("New document")');
  await a.waitForSelector('.doc-editor-text');
  await a.fill('textarea[aria-label="Title"]', 'Trip plan');
  await a.click('.doc-editor-text');
  await a.keyboard.type('Where we go');
  await a.keyboard.press('Enter');
  await a.keyboard.type('What we bring');
  await a.check('.doc-open-editing input');
  await a.click('button:has-text("Publish")');
  await a.waitForSelector('.document-page h1.document-title:has-text("Trip plan")');
  const docPath = new URL(a.url());
  console.log('published, open to editing');

  // Bob opens it: Edit, but no Delete. Carol reads it.
  for (const p of [b, c]) {
    await p.goto(`${BASE}${docPath.pathname}${docPath.search}`);
    await p.waitForSelector('.document-page h1.document-title:has-text("Trip plan")');
  }
  if (!(await b.isVisible('.document-page-actions button:has-text("Edit")'))) throw new Error('bob has no Edit');
  if (await b.isVisible('button[aria-label="Delete document"]')) throw new Error('bob can delete alice\'s document');

  // Both edit.
  await a.click('.document-page-actions button:has-text("Edit")');
  await saved(a);
  await b.click('.document-page-actions button:has-text("Edit")');
  await saved(b);
  await a.waitForSelector('.doc-editors .doc-editor-person');
  await b.waitForSelector('.doc-editors .doc-editor-person');
  console.log('both editing; each sees the other in the bar');

  // At once: Alice at the end of the first line, Bob at the end of the second.
  await a.click('.doc-editor-text p >> nth=0');
  await move(a, 'End');
  await b.click('.doc-editor-text p >> nth=1');
  await move(b, 'End');
  await Promise.all([
    a.keyboard.type(': the mountains', { delay: 30 }),
    b.keyboard.type(': boots and tea', { delay: 30 }),
  ]);
  const want = 'Where we go: the mountains\nWhat we bring: boots and tea';
  for (const [name, p] of [['alice', a], ['bob', b]]) {
    await p.waitForFunction(() => document.querySelector('.doc-editor-text')?.textContent.includes('boots and tea')
      && document.querySelector('.doc-editor-text')?.textContent.includes('the mountains'), null, { timeout: 10000 });
    const got = await editorText(p);
    if (got !== want) throw new Error(`${name}'s editor: ${JSON.stringify(got)}`);
  }
  // In the same paragraph, at once.
  await move(a, 'End');
  await b.click('.doc-editor-text p >> nth=0');
  await move(b, 'Home');
  await Promise.all([
    a.keyboard.type(' and lakes', { delay: 25 }),
    b.keyboard.type('First: ', { delay: 25 }),
  ]);
  const want2 = 'First: Where we go: the mountains and lakes\nWhat we bring: boots and tea';
  for (const [name, p] of [['alice', a], ['bob', b]]) {
    await p.waitForFunction((w) => {
      const copy = document.querySelector('.doc-editor-text').cloneNode(true);
      copy.querySelectorAll('.collab-caret').forEach((x) => x.remove());
      return [...copy.children].map((block) => block.textContent).join('\n') === w;
    }, want2, { timeout: 10000 }).catch(async () => { throw new Error(`${name}'s editor: ${JSON.stringify(await editorText(p))}`); });
  }
  console.log('typed at once (different and same paragraph): both editors agree');

  // Each sees the other's caret, with their name, where they are.
  const caretIn = (p) => p.evaluate(() => {
    const caret = document.querySelector('.doc-editor-text .collab-caret');
    if (!caret) return null;
    const block = caret.closest('p');
    const copy = block.cloneNode(true);
    const marker = copy.querySelector('.collab-caret');
    marker.replaceWith('|');
    return { name: caret.textContent, text: copy.textContent };
  });
  await a.waitForFunction(() => document.querySelector('.doc-editor-text .collab-caret'));
  const bobsCaret = await caretIn(a);
  if (!bobsCaret?.name.startsWith('bob') || bobsCaret.text !== 'First: |Where we go: the mountains and lakes') throw new Error(`bob's caret in alice's editor: ${JSON.stringify(bobsCaret)}`);
  const alicesCaret = await caretIn(b);
  if (!alicesCaret?.name.startsWith('alice') || !alicesCaret.text.endsWith('and lakes|')) throw new Error(`alice's caret in bob's editor: ${JSON.stringify(alicesCaret)}`);
  await shot(a, 'alice-editing');
  await shot(b, 'bob-editing');
  console.log('carets: each where the other is, with their names');

  // Carol's page follows without anyone pressing anything.
  await c.waitForSelector('.document-page-inner .document-body p:has-text("First: Where we go: the mountains and lakes")', { timeout: 15000 });
  await shot(c, 'carol-reading');
  console.log('carol, reading: the page follows the saves');

  // A title change reaches the other editor.
  await a.fill('textarea[aria-label="Title"]', 'Mountain trip');
  await b.waitForFunction(() => document.querySelector('textarea[aria-label="Title"]').value === 'Mountain trip', null, { timeout: 10000 });
  console.log('title followed');

  // Bob goes offline and types; back online, it arrives.
  await b.context().setOffline(true);
  await b.click('.doc-editor-text p >> nth=1');
  await move(b, 'End');
  await b.keyboard.type(' and maps');
  await b.waitForSelector('.doc-editor-status:has-text("Offline")', { timeout: 15000 });
  await b.context().setOffline(false);
  await a.waitForFunction(() => document.querySelector('.doc-editor-text').textContent.includes('boots and tea and maps'), null, { timeout: 20000 });
  await saved(b);
  console.log('offline typing arrived once back');

  // Alice closes it to editing: Bob's editor stops (at his next request).
  await a.uncheck('.doc-open-editing input');
  await saved(a);
  await b.keyboard.type('!');
  await b.waitForSelector('.doc-conflict:has-text("can\'t edit this document any more")', { timeout: 30000 });
  if (await b.$eval('.doc-editor-text', (el) => el.getAttribute('contenteditable')) !== 'false') throw new Error('bob can still type');
  console.log('closed to editing: bob stopped');

  await a.click('button:has-text("Done")');
  await a.waitForSelector('.document-page-inner .document-body p:has-text("boots and tea and maps")');
  if ((await a.textContent('h1.document-title')) !== 'Mountain trip') throw new Error('title not kept');
  console.log('done: the page shows it all');

  // A phone editing: fits.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  p.on('pageerror', (e) => console.log('[phone] page error:', e.message));
  await p.goto(`${BASE}/`);
  await p.evaluate((token) => localStorage.setItem('token', token), await a.evaluate(() => localStorage.getItem('token')));
  await p.goto(`${BASE}${docPath.pathname}${docPath.search}&edit=1`);
  await saved(p);
  await noOverflow(p, 'phone editor');
  await shot(p, 'phone-editing');
  console.log('phone editor fits the screen');

  console.log('docslive e2e: ok');
} catch (err) {
  console.error('docslive e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  for (const [name, page] of pages) await shot(page, `failed-${name}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
