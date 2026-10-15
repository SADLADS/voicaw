// Phone: the message box's panels (the + panel, the emoji/GIF panel) close with Back and with a
// swipe to the list, instead of Back leaving the chat or the list being shown with the panel
// still open behind it (hooks/useBackCloses.js useBackClosesWhile, hooks/useSwipePanes.js).
//   node e2e/serve.mjs &   then   node e2e/composerback.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const pane = (page) => page.evaluate(() => {
  const w = document.querySelector('.main-wrapper');
  if (!w) return 'none';
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'none';
});
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });
  await page.waitForTimeout(200);
};
const back = async (page) => {
  await page.evaluate(() => history.back());
  await page.waitForTimeout(300);
  await settle(page);
};
const open = async (page, selector) => !!(await page.$(selector));

// A one-finger swipe to the right over the messages (CDP touch events), as in panes.mjs.
async function swipeRight(page) {
  const { width, height } = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
  });
  const y = height * 0.3;
  await touch('touchStart', 30, y);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', 30 + (width * 0.7 * i) / 12, y);
    await new Promise((r) => setTimeout(r, 16));
  }
  await touch('touchEnd');
  await cdp.detach();
  await page.waitForTimeout(300);
  await settle(page);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 15; i++) await send(alice.page, `message number ${i}`);

  const page = bob.page;
  page.on('pageerror', (e) => console.log('[bob] page error:', e.message));
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 15');
  await settle(page);
  check(await pane(page) === 'content', 'opens on the chat');

  // The + panel: Back closes it, staying in the chat; Back again shows the list.
  await page.tap('button[aria-label="Add"]');
  await page.waitForSelector('.attach-panel');
  await shot(page, '1-plus-panel');
  await back(page);
  check(!(await open(page, '.attach-panel')), 'Back closes the + panel');
  check(await pane(page) === 'content', 'and stays in the chat');
  await back(page);
  check(await pane(page) === 'list', 'Back again shows the list');

  // The emoji panel the same, and swapping to the + panel and back doesn't stack entries.
  await page.tap(`.dm-user[href="/dm/${alice.id}"]`);
  await page.waitForSelector('#dm-input');
  await settle(page);
  check(await pane(page) === 'content', 'the chat again');
  await page.getByRole('button', { name: 'Emoji' }).tap();
  await page.waitForSelector('.emoji-picker.docked');
  await page.tap('button[aria-label="Add"]');
  await page.waitForSelector('.attach-panel');
  await page.getByRole('button', { name: 'Emoji' }).tap();
  await page.waitForSelector('.emoji-picker.docked');
  const gifs = page.getByRole('tab', { name: 'GIFs' });
  if (await gifs.count()) {
    await gifs.tap();
    await page.waitForSelector('.emoji-picker.gifs');
  }
  await shot(page, '2-emoji-panel');
  await back(page);
  check(!(await open(page, '.emoji-picker')) && !(await open(page, '.attach-panel')), 'Back closes the emoji/GIF panel after swapping panels');
  check(await pane(page) === 'content', 'still in the chat');

  // Closing it another way (the keyboard button) takes its entry out: Back shows the list.
  await page.getByRole('button', { name: 'Emoji' }).tap();
  await page.waitForSelector('.emoji-picker.docked');
  await page.getByRole('button', { name: 'Show keyboard' }).tap();
  await page.waitForSelector('.emoji-picker', { state: 'detached' });
  await page.waitForTimeout(700); // its entry goes after a moment (CLOSE_DELAY_MS)
  await back(page);
  check(await pane(page) === 'list', 'closed with the keyboard button, Back shows the list');

  // Swiping to the list closes them, and the list stays (no bounce back to the chat).
  await page.tap(`.dm-user[href="/dm/${alice.id}"]`);
  await page.waitForSelector('#dm-input');
  await settle(page);
  await page.tap('button[aria-label="Add"]');
  await page.waitForSelector('.attach-panel');
  await swipeRight(page);
  await page.waitForTimeout(500);
  check(await pane(page) === 'list', 'swiping right with the + panel open shows the list');
  check(!(await open(page, '.attach-panel')), 'and closes the + panel');
  await shot(page, '3-after-swipe');

  await page.tap(`.dm-user[href="/dm/${alice.id}"]`);
  await page.waitForSelector('#dm-input');
  await settle(page);
  await page.getByRole('button', { name: 'Emoji' }).tap();
  await page.waitForSelector('.emoji-picker.docked');
  await page.tap('.pane-back-button');
  await page.waitForTimeout(500);
  await settle(page);
  check(await pane(page) === 'list', 'the header arrow with the emoji panel open shows the list');
  check(!(await open(page, '.emoji-picker')), 'and closes the emoji panel');
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => history.state ?? {});
  check(!state.voicawPane && !state.voicawComposerPanel && !state.voicawOverlays, 'on the list\'s own entry, no panel entry left');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
