// Ctrl+Backspace beside an attachment chip: typing "Hello" right after an attached picture and
// pressing Ctrl+Backspace deletes the word only, not the chip (the browser's own word delete
// took both); Ctrl+Delete the same forwards; a second Ctrl+Backspace then takes the chip. The
// sent message's reply snippet spaces the file name from the text ("📎 image.png Hello").
//   node e2e/serve.mjs &   then   node e2e/worddelete.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const chips = (page) => page.locator('#dm-input .editor-attachment').count();
const boxText = (page) => page.$eval('#dm-input', (el) => el.textContent);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  const a = alice.page;

  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles([{ name: 'image.png', mimeType: 'image/png', buffer: png }]);
  await a.waitForSelector('#dm-input .editor-attachment');
  await a.click('#dm-input');
  await a.keyboard.press('End');
  await a.keyboard.type('Hello');
  check((await boxText(a)).endsWith('image.pngHello'), 'chip, then Hello against it');

  await a.keyboard.press('Control+Backspace');
  check(await chips(a) === 1, 'Ctrl+Backspace keeps the chip');
  check((await boxText(a)).endsWith('image.png'), `and deletes Hello only ("${await boxText(a)}")`);

  await a.keyboard.type('Hello world');
  await a.keyboard.press('Control+Backspace');
  check((await boxText(a)).endsWith('image.pngHello '), 'one word at a time');
  await a.keyboard.press('Control+Backspace');
  await a.keyboard.type('Hello');
  // Left until the cursor is just before "Hello" (Chrome may spend a press on the chip's edge).
  const beforeHello = () => a.evaluate(() => {
    const s = window.getSelection();
    return s.anchorNode?.nodeType === 3 && s.anchorNode.textContent === 'Hello' && s.anchorOffset === 0;
  });
  for (let i = 0; i < 8 && !(await beforeHello()); i++) await a.keyboard.press('ArrowLeft');
  check(await beforeHello(), 'cursor between the chip and Hello');
  // Cursor between the chip and "Hello": Ctrl+Delete takes the word ahead, not the chip.
  await a.keyboard.press('Control+Delete');
  check(await chips(a) === 1 && (await boxText(a)).endsWith('image.png'), `Ctrl+Delete deletes the word ahead only ("${await boxText(a)}", ${await chips(a)} chip)`);
  await a.keyboard.type('Hello');
  await shot(a, 'box');

  await a.keyboard.press('Enter');
  await bob.page.waitForSelector('.dm-message-content img, .dm-message-content .attachment', { timeout: 20000 });
  await bob.page.locator('.each-dm-message-wrapper').last().hover();
  await bob.page.locator('.each-dm-message-wrapper').last().locator('.message-menu button:has(svg[data-icon="reply"])').click();
  await bob.page.keyboard.type('nice');
  await bob.page.keyboard.press('Enter');
  const preview = bob.page.locator('.reply-preview').last();
  await preview.waitFor({ timeout: 20000 });
  const text = await preview.innerText();
  check(text.includes('image.png Hello'), `reply snippet spaces the file name ("${text.replace(/\s+/g, ' ')}")`);
  await shot(bob.page, 'reply');

  // Now the chip itself: nothing but spaces between it and the cursor.
  await a.click('#dm-input');
  const [chooser2] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser2.setFiles([{ name: 'image.png', mimeType: 'image/png', buffer: png }]);
  await a.waitForSelector('#dm-input .editor-attachment');
  await a.click('#dm-input');
  await a.keyboard.press('End');
  await a.keyboard.press('Control+Backspace');
  check(await chips(a) === 0, 'Ctrl+Backspace right after a chip deletes the chip');
  console.log('worddelete: ok');
} catch (err) {
  console.error('worddelete: FAILED', err.message.split('\n')[0], err.stack.split('\n').find((l) => l.includes('.mjs')));
  process.exitCode = 1;
} finally {
  await browser.close();
}
