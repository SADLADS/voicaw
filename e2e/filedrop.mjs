// Files dropped anywhere, like Discord: a file dragged in from outside covers the window with
// "Upload to <chat>" and dropping it anywhere attaches it to the message (DM, guild channel,
// a document's replies); leaving the window hides it; drags from inside the page and drags
// over a dialog are left alone. In the document editor an image dropped on "Add a cover image"
// becomes the cover and one dropped on the text still goes into the text (no overlay there).
// Then a phone. Drags are made with real DataTransfers holding a canvas-made PNG.
//   node e2e/serve.mjs &   then   node e2e/filedrop.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Fires dragenter/dragover (and `drop`, or dragleave to leave the window) at the element under
// (x, y) or at `selector`, as a drag of a PNG named `name` from outside the page would.
// `fromPage` fires dragstart first, as a drag of something on the page does.
function drag(page, { at, selector, steps = ['enter', 'over'], name = 'dropped.png', fromPage = false }) {
  return page.evaluate(async ({ at, selector, steps, name, fromPage }) => {
    if (!window.__dropFile) {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 60;
      const g = canvas.getContext('2d');
      g.fillStyle = '#3a8';
      g.fillRect(0, 0, 120, 60);
      window.__dropFile = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    const dt = new DataTransfer();
    dt.items.add(new File([window.__dropFile], name, { type: 'image/png' }));
    let target;
    let x;
    let y;
    if (selector) {
      target = document.querySelector(selector);
      const r = target.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    } else {
      [x, y] = at;
    }
    const fire = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    if (fromPage) fire('dragstart', document.querySelector('.message-list, main, body') || document.body);
    for (const step of steps) {
      // After the first event the overlay may be on top: aim at whatever is there now.
      const el = selector ? document.querySelector(selector) : document.elementFromPoint(x, y);
      target = el || target;
      if (step === 'enter') fire('dragenter', target);
      if (step === 'over') fire('dragover', target);
      if (step === 'leave') fire('dragleave', target);
      if (step === 'drop') fire('drop', target);
      if (step === 'end') fire('dragend', document.body);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    }
  }, { at, selector, steps, name, fromPage });
}

const overlayText = (page) => page.evaluate(() => document.querySelector('.file-drop-overlay')?.textContent ?? null);
const chips = (page) => page.$$eval('.attachment-draft', (els) => els.map((e) => e.title));
const expect = (ok, what) => { if (!ok) throw new Error(what); };

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;

  // DM: overlay over everything, then drop on the message list (far from the box).
  await openChat(a, bob.id);
  await drag(a, { at: [600, 200] });
  const text = await overlayText(a);
  expect(text?.includes('Upload to') && text.includes(bob.name), `DM overlay: ${text}`);
  const covers = await a.evaluate(() => {
    const r = document.querySelector('.file-drop-overlay').getBoundingClientRect();
    return r.width === window.innerWidth && r.height === window.innerHeight;
  });
  expect(covers, 'overlay should cover the window');
  await shot(a, 'dm-overlay');
  await drag(a, { at: [600, 200], steps: ['over', 'drop'] });
  expect((await overlayText(a)) === null, 'overlay should go after the drop');
  await a.waitForSelector('.attachment-draft');
  expect((await chips(a)).join() === 'dropped.png', `DM chips: ${await chips(a)}`);
  console.log('DM: overlay "Upload to <name>", drop on the message list attaches the file');

  // Leaving the window (enter, then leave with nothing re-entered).
  await drag(a, { at: [600, 200], steps: ['enter'] });
  expect((await overlayText(a)) !== null, 'overlay on enter');
  await drag(a, { at: [600, 200], steps: ['leave'] });
  expect((await overlayText(a)) === null, 'overlay should go when the drag leaves');
  // A drag that started in the page (an image from a message) is left alone.
  await drag(a, { at: [600, 200], fromPage: true, steps: ['enter', 'over'] });
  expect((await overlayText(a)) === null, 'no overlay for a drag from the page');
  await drag(a, { at: [600, 200], steps: ['end'] });
  console.log('leaving the window hides it; drags from the page get none');

  // Guild: text channel, then a dialog open (Create Channel) gets no overlay.
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Droppers');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input[aria-label="Message #general"]');
  await drag(a, { at: [600, 200] });
  expect((await overlayText(a))?.includes('#general'), `guild overlay: ${await overlayText(a)}`);
  await drag(a, { at: [600, 200], steps: ['over', 'drop'], name: 'guild.png' });
  await a.waitForSelector('.attachment-draft[title="guild.png"]');
  console.log('guild channel: "Upload to #general", drop attaches');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.waitForSelector('[aria-modal="true"]');
  await drag(a, { at: [600, 300] });
  expect((await overlayText(a)) === null, 'no overlay while a dialog is open');
  await drag(a, { at: [600, 300], steps: ['leave'] });

  // A document channel: the editor's cover button and body, then replies.
  await a.check('input[name="channel-type"][value="doc"]');
  await a.fill('#channel-name', 'Handbook');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.click('.guild-channel-link:has-text("handbook")');
  await a.waitForSelector('.document-feed');
  await a.click('button:has-text("New document")');
  await a.waitForSelector('.doc-editor-text');
  await a.fill('textarea[aria-label="Title"]', 'Dropped');
  await drag(a, { selector: '.doc-add-cover', steps: ['enter', 'over'] });
  expect((await overlayText(a)) === null, 'no overlay in the editor');
  expect(await a.$eval('.doc-add-cover', (el) => el.classList.contains('drag-over')), 'cover button highlighted');
  await shot(a, 'cover-drag');
  await drag(a, { selector: '.doc-add-cover', steps: ['drop'], name: 'cover.png' });
  await a.waitForFunction(() => { const img = document.querySelector('.doc-editor-cover .document-cover img'); return img?.complete && img.naturalWidth > 0; }, null, { timeout: 10000 });
  console.log('editor: image dropped on "Add a cover image" is the cover');
  await a.click('.doc-editor-text');
  await a.keyboard.type('Some text');
  await drag(a, { selector: '.doc-editor-text', steps: ['enter', 'over', 'drop'], name: 'body.png' });
  await a.waitForFunction(() => document.querySelector('.doc-editor-text img'), null, { timeout: 10000 });
  expect(!(await a.$('.doc-editor-text img[src*="cover"]')), 'body image is its own');
  console.log('editor: image dropped on the text still goes into the text');
  await a.click('button:has-text("Publish")');
  await a.waitForSelector('.document-replies');
  await drag(a, { at: [300, 300] });
  expect((await overlayText(a))?.includes('replies to Dropped'), `replies overlay: ${await overlayText(a)}`);
  await drag(a, { at: [300, 300], steps: ['over', 'drop'], name: 'reply.png' });
  await a.waitForSelector('.attachment-draft[title="reply.png"]');
  console.log('document page: drop anywhere attaches to the replies');

  // Phone: the overlay fits.
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const p = carol.page;
  await openChat(p, alice.id);
  await drag(p, { at: [200, 300] });
  const fits = await p.evaluate(() => {
    const card = document.querySelector('.file-drop-card').getBoundingClientRect();
    return card.left >= 0 && card.right <= window.innerWidth;
  });
  expect(fits, 'phone: card should fit the screen');
  await shot(p, 'phone-overlay');
  await drag(p, { at: [200, 300], steps: ['over', 'drop'] });
  await p.waitForSelector('.attachment-draft');
  console.log('phone: overlay fits, drop attaches');

  console.log('filedrop: ok');
} catch (err) {
  console.error('filedrop: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
