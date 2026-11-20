// Other sites' pictures in the document editor, with Settings → Privacy's "Show pictures and
// videos from links straight away" off (documents/editorSetup.js ImageView): a picture pasted into
// a document waits behind "Picture from <site>" and Show, the site gets no request until then,
// Show loads it; dark and light. (With it on, the default, it loads at once: editorSetup.test.js.)
//   node e2e/serve.mjs &   then   node e2e/docimages.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

// "Another site": the web server's own logo, by another name for the same computer.
const PICTURE = `${BASE.replace('localhost', '[::1]')}/logo192.png`;

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  const asked = [];
  a.on('request', (req) => { if (req.url().startsWith(PICTURE)) asked.push(req.url()); });
  a.on('pageerror', (e) => console.log('[alice] page error:', e.message));

  // Settings → Privacy's setting off (kept per device in localStorage).
  await a.evaluate(() => localStorage.setItem('privacy', JSON.stringify({ linkPreviews: false })));
  await a.reload();
  await a.waitForSelector('button[aria-label="Add a guild"]');

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Writers');
  await a.click('button:has-text("Create")');
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
  await a.fill('textarea[aria-label="Title"]', 'Pictures');
  await a.click('.doc-editor-text');
  await a.keyboard.type('Our logo:');
  await a.keyboard.press('Enter');
  await a.evaluate((src) => {
    const data = new DataTransfer();
    data.setData('text/html', `<p><img src="${src}" alt="logo"></p>`);
    data.setData('text/plain', '');
    document.querySelector('.doc-editor-text [contenteditable="true"], .doc-editor-text[contenteditable="true"]')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PICTURE);
  await a.waitForSelector('.doc-editor-image-hidden');
  await a.waitForTimeout(500);
  check(asked.length === 0, 'the pasted picture asked its site for nothing');
  check((await a.textContent('.doc-editor-image-hidden')).includes('[::1]'), 'the box says which site it is from');
  check(!(await a.$('img.doc-editor-image')), 'no picture drawn yet');
  await shot(a, 'docimages-held-dark');
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await a.waitForTimeout(500); // the theme's colour transition
  await shot(a, 'docimages-held-light');
  await a.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  await a.click('.doc-editor-image-hidden button');
  await a.waitForFunction(() => {
    const img = document.querySelector('img.doc-editor-image');
    return img && img.complete && img.naturalWidth > 0;
  });
  check(asked.length > 0, 'Show loads it');
  check(!(await a.$('.doc-editor-image-hidden')), 'the box is gone');
  await shot(a, 'docimages-shown');

  console.log('docimages: all good');
} finally {
  await browser.close();
}
