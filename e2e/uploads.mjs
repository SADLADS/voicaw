// Deleting files (docs/uploads.md): a DM's attachment is listed with the message it's sent in
// and gone from the object store once that message is deleted; the same for a guild channel
// (the server reads those itself). A file in a message that stays is kept.
//   node e2e/serve.mjs &   then   node e2e/uploads.mjs
import { createRequire } from 'node:module';
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const picture = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a7' } }).png().toBuffer();

const PICTURE = '.each-dm-message-wrapper:has(img.attachment-media)';
let failed = false;
function check(ok, what) {
  console.log(`${ok ? 'ok' : 'FAILED'}: ${what}`);
  if (!ok) failed = true;
}

// Each upload URL the page gets (`fileUrl`), and the `uploads` each send listed.
function watch(page) {
  const seen = { files: [], lists: [] };
  page.on('response', async (res) => {
    if (res.url().includes('/api/upload_file') && res.ok()) seen.files.push((await res.json()).fileUrl);
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/(dm-send|channels\/\d+\/messages)$/.test(req.url())) {
      seen.lists.push(JSON.parse(req.postData() ?? '{}').uploads);
    }
  });
  return seen;
}

async function attachAndSend(page, name, text) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType: 'image/png', buffer: picture });
  await page.waitForSelector('.attachment-draft');
  await send(page, text);
}

// Whether the object store still has the file (a public GET, as anyone would).
const stored = async (url) => (await fetch(url)).status === 200;
async function waitGone(url) {
  for (let i = 0; i < 50; i++) {
    if (!(await stored(url))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Deletes the message with `text` (and a picture) by its right-click menu on the text (the
// picture has its own menu); Shift: no question.
async function deletePictureMessage(page, text) {
  const before = await page.locator(PICTURE).count();
  await page.locator('.dm-message-content').getByText(text).click({ button: 'right' });
  await page.waitForSelector('.context-menu');
  await page.keyboard.down('Shift');
  await page.click('.context-menu [role="menuitem"]:has-text("Delete Message")');
  await page.keyboard.up('Shift');
  await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n - 1, [PICTURE, before], { timeout: 10000 });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const seen = watch(alice.page);
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  // Two pictures in two messages; bob sees them.
  await attachAndSend(alice.page, 'keep.png', 'this one stays');
  await bob.page.waitForSelector(`${PICTURE} img.attachment-media`, { timeout: 20000 });
  await attachAndSend(alice.page, 'gone.png', 'this one goes');
  await bob.page.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, PICTURE, { timeout: 20000 });
  const [keep, gone] = seen.files;
  const name = (url) => url.split('/uploads/')[1];
  check(seen.lists.length === 2 && seen.lists[0]?.join() === name(keep) && seen.lists[1]?.join() === name(gone),
    `each DM send lists its file (${JSON.stringify(seen.lists)})`);
  check(await stored(keep) && await stored(gone), 'both files are in the object store');

  await deletePictureMessage(alice.page, 'this one goes');
  check(await waitGone(gone), "the deleted DM's file is gone from the object store");
  check(await stored(keep), "the other message's file is kept");
  await bob.page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, PICTURE, { timeout: 10000 });
  check(true, 'bob still sees the message that stays');

  // A guild channel: the server reads the file from the message itself.
  await alice.page.click('button[aria-label="Add a guild"]');
  await alice.page.fill('#new-guild-name', 'Files');
  await alice.page.click('button:has-text("Create")');
  await alice.page.waitForSelector('#dm-input[aria-label="Message #general"]');
  // (The picture shows from the local copy at once: wait for the message itself to be sent.)
  const posted = alice.page.waitForResponse((res) => /\/api\/channels\/\d+\/messages$/.test(res.url()) && res.request().method() === 'POST', { timeout: 20000 });
  await attachAndSend(alice.page, 'guild.png', 'in the guild');
  await posted;
  const guildFile = seen.files.at(-1);
  check(seen.lists.at(-1) === undefined, 'a guild message sends no list (the server reads it)');
  check(await stored(guildFile), "the guild message's file is stored");
  await deletePictureMessage(alice.page, 'in the guild');
  check(await waitGone(guildFile), "the deleted guild message's file is gone");
} finally {
  await browser.close();
}
if (failed) process.exit(1);
