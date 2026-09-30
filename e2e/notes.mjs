// Notes (a DM to yourself): pinned above the DMs, sent, still readable after a reload (the
// key is derived again on the device), a DM to someone else doesn't show up in it, nobody
// else sees it, and the phone layout.
//   node e2e/serve.mjs &   then   node e2e/notes.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

const shots = process.argv[2];
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const page = alice.page;

  // The Notes row comes before the Direct Messages header, and you aren't in the DM list.
  await page.goto(`${BASE}/dm`);
  await page.waitForSelector('.dm-notes-link');
  const order = await page.evaluate(() => {
    const notes = document.querySelector('.dm-notes-link');
    const header = document.querySelector('.direct-messages-header');
    return Boolean(notes.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (!order) throw new Error('Notes is not above the Direct Messages header');
  if (await page.$(`a.dm-user[href="/dm/${alice.id}"]`)) throw new Error('you are listed in your own DMs');

  await page.click('.dm-notes-link');
  await page.waitForURL(/\/dm\/notes$/);
  await page.waitForSelector('text=Nothing here yet');
  await send(page, 'buy **milk**');
  await page.waitForSelector('.dm-message >> text=milk');
  await page.waitForSelector('.dm-message:not(.pending) >> text=milk');

  // A DM to Bob from another tab doesn't turn up in the notes on screen.
  const other = await page.context().newPage();
  await openChat(other, bob.id);
  await send(other, 'hi bob');
  await bob.page.goto(`${BASE}/dm/${alice.id}`);
  await bob.page.waitForSelector('text=hi bob', { timeout: 10000 });
  await page.waitForTimeout(1000);
  if (await page.$('text=hi bob')) throw new Error('a DM to Bob showed up in notes');
  await other.close();

  // Reloaded, the note is decrypted again; Bob never sees it.
  await page.reload();
  await page.waitForSelector('.dm-message >> text=milk', { timeout: 10000 });
  if (await bob.page.$('text=milk')) throw new Error('Bob sees the note');
  if (await page.$('.dm-notes-link .userdot.active')) throw new Error('notes show as unread');
  await shot(page, 'notes-desktop');

  // A phone, logging in fresh: a new device derives the same notes key.
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phoneCtx.newPage();
  await p.goto(BASE);
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.dm-notes-link', { timeout: 15000 });
  await shot(p, 'notes-phone-list');
  await p.click('.dm-notes-link');
  await p.waitForSelector('.dm-message >> text=milk', { timeout: 15000 });
  await p.waitForTimeout(800); // the slide over to the chat
  await shot(p, 'notes-phone-chat');
  await phoneCtx.close();

  console.log('notes: ok');
} catch (err) {
  console.error('notes: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
