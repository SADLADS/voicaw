// Phone panes (hooks/useSwipePanes.js): swipe between the list and the chat, flicks and slow
// drags, scrolling messages never moves them, back button, the header's back arrow (DM, notes,
// guild channel; none on a computer), guild channels.
//   node e2e/serve.mjs &   then   node e2e/panes.mjs [screenshot dir]
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
  if (w.classList.contains('panes-moving')) return 'moving';
  return w.classList.contains('pane-content') ? 'content' : w.classList.contains('pane-list') ? 'list' : 'none';
});
const settle = (page) => page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });

// A one-finger drag through CDP touch events: from (x, y) by (dx, dy) in `steps` moves,
// `ms` apart; `hold`: leave the finger down (returns the lift function).
async function drag(page, { x, y, dx, dy = 0, steps = 10, ms = 16, hold = false }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
  });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y + (dy * i) / steps);
    await new Promise((r) => setTimeout(r, ms));
  }
  const lift = async () => { await touch('touchEnd'); await cdp.detach(); };
  if (hold) return lift;
  await lift();
  return null;
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 30; i++) await send(alice.page, `message number ${i}\nsecond line`);

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 30');
  await settle(page);
  const { width, height } = page.viewportSize();
  check(await pane(page) === 'content', 'opens on the chat');
  await shot(page, '1-chat');

  // Scrolling the messages, even a bit diagonally, doesn't move the panes.
  const before = await page.$eval('.message-scroller', (el) => el.scrollTop).catch(() => null);
  await drag(page, { x: width * 0.4, y: height * 0.35, dx: 25, dy: 180, steps: 12 });
  await page.waitForTimeout(400);
  check(await pane(page) === 'content', 'a mostly vertical swipe scrolls instead');
  if (before !== null) {
    const after = await page.$eval('.message-scroller', (el) => el.scrollTop);
    check(after !== before, 'and the messages scrolled');
  }

  // Slow drag a third of the way and let go: slides back.
  const lift = await drag(page, { x: 40, y: height * 0.5, dx: width * 0.3, steps: 15, ms: 40, hold: true });
  check(await pane(page) === 'moving', 'the chat follows the finger');
  await shot(page, '2-mid-drag');
  await page.waitForTimeout(150); // held still: no fling
  await lift();
  await settle(page);
  check(await pane(page) === 'content', 'a short slow drag goes back to the chat');

  // Flick a short way: goes to the list.
  const historyBefore = await page.evaluate(() => history.length);
  await drag(page, { x: 40, y: height * 0.5, dx: width * 0.25, steps: 4, ms: 8 });
  await settle(page);
  check(await pane(page) === 'list', 'a quick flick opens the list');
  await shot(page, '3-list');
  check(await page.evaluate(() => !history.state?.voicawPane), 'the list is the entry under the chat');

  // Swipe left from the list: the chat again.
  await drag(page, { x: width - 40, y: height * 0.5, dx: -width * 0.7, steps: 10 });
  await settle(page);
  check(await pane(page) === 'content', 'swiping left shows the chat');

  // Back button: the list, not another page.
  const url = page.url();
  await page.goBack();
  await settle(page);
  check(await pane(page) === 'list' && page.url() === url, 'back slides to the list, same chat');

  // Tapping a conversation opens it; back returns to the list (no pile of entries).
  await page.click(`#dm-sidebar a[href="/dm/${alice.id}"]`);
  await settle(page);
  check(await pane(page) === 'content', 'tapping a conversation opens it');
  await page.goBack();
  await settle(page);
  check(await pane(page) === 'list', 'back from it is the list');
  check(await page.evaluate(() => history.length) <= historyBefore + 1, 'history doesn\'t grow with each open');

  // The header's arrow: at its left, slides to the list like a swipe; none on a computer.
  await page.click(`#dm-sidebar a[href="/dm/${alice.id}"]`);
  await settle(page);
  const arrow = await page.$eval('.chat-recipient-header .pane-back-button', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, w: r.width, first: el === el.parentElement.firstElementChild };
  }).catch(() => null);
  check(arrow && arrow.first && arrow.x < 16 && arrow.w >= 32, 'a DM\'s header starts with a back arrow');
  await shot(page, '3b-arrow');
  const arrowUrl = page.url();
  await page.click('.chat-recipient-header .pane-back-button');
  await settle(page);
  check(await pane(page) === 'list' && page.url() === arrowUrl, 'tapping it slides to the list, same chat');
  check(await page.evaluate(() => !history.state?.voicawPane), 'and takes the chat\'s history entry away like back');
  check(!(await alice.page.$('.pane-back-button')), 'no back arrow on a computer');

  // Notes and back.
  await page.click('a[href="/dm/notes"]');
  await settle(page);
  check(await pane(page) === 'content' && page.url().endsWith('/dm/notes'), 'notes open as the chat');
  await page.click('.chat-recipient-header .pane-back-button');
  await settle(page);
  check(await pane(page) === 'list', 'notes\' back arrow');
  await page.click('a[href="/dm/notes"]');
  await settle(page);
  await drag(page, { x: 40, y: height * 0.5, dx: width * 0.6, steps: 10 });
  await settle(page);
  check(await pane(page) === 'list', 'swipe back from notes');

  // Guild: a channel opens as the chat, swipe back to the channel list.
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/guilds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pane Guild' }),
    });
    return res.json();
  });
  const guildId = created.id ?? created.guild?.id;
  await page.click(`a[href^="/guild/${guildId}"]`);
  await page.waitForSelector('.guild-channel-link');
  await settle(page);
  await shot(page, '4-guild');
  check(await pane(page) === 'list', 'a guild opens on its channel list');
  await page.click('.guild-channel-link');
  await settle(page);
  check(await pane(page) === 'content', 'a channel opens as the chat');
  await shot(page, '5-channel');
  await drag(page, { x: 40, y: height * 0.5, dx: width * 0.6, steps: 10 });
  await settle(page);
  check(await pane(page) === 'list', 'swipe back to the channels');
  await page.click('.guild-channel-link');
  await settle(page);
  const channelArrow = await page.$eval('.channel-header .pane-back-button', (el) => el === el.parentElement.firstElementChild).catch(() => false);
  check(channelArrow, 'a channel\'s header starts with a back arrow');
  await shot(page, '6-channel-arrow');
  await page.click('.channel-header .pane-back-button');
  await settle(page);
  check(await pane(page) === 'list', 'and it goes back to the channels');

  console.log(failures ? `panes: ${failures} FAILED` : 'panes: ok');
  if (failures) process.exitCode = 1;
} catch (err) {
  console.error('panes: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
