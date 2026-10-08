// Phone panes after a guild opened from the rail (hooks/useSwipePanes.js): the guild shows its
// channel list, swiping left shows its channel, swiping back must show that guild's channels,
// not the DM list the chat showed before (it used to: the chat's page was only noted when the
// URL changed, and a swipe doesn't change it). Also after tapping a channel, and after a reload.
//   node e2e/serve.mjs &   then   node e2e/guildswipe.mjs [screenshot dir]
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
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 3000 });
  await page.waitForTimeout(150); // a navigation after the slide would have happened by now
};
const path = (page) => new URL(page.url()).pathname;

async function drag(page, { x, y, dx, steps = 10, ms = 16 }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
  });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y);
    await new Promise((r) => setTimeout(r, ms));
  }
  await touch('touchEnd');
  await cdp.detach();
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello bob');

  const page = bob.page;
  const { width, height } = page.viewportSize();
  const swipeRight = () => drag(page, { x: 40, y: height * 0.5, dx: width * 0.6 });
  const swipeLeft = () => drag(page, { x: width - 40, y: height * 0.5, dx: -width * 0.7 });
  const showsChannels = () => page.$eval('.main-wrapper', (w) => Boolean(w.querySelector('.guild-channel-link'))
    && !w.querySelector('#dm-sidebar')).catch(() => false);

  await openChat(page, alice.id);
  await page.waitForSelector('text=hello bob');
  await settle(page);
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/guilds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Swipe Guild' }),
    });
    return res.json();
  });
  const guildId = created.id ?? created.guild?.id;

  // From a DM chat: back to the list, the guild on the rail, swipe left to its channel.
  await swipeRight();
  await settle(page);
  check(await pane(page) === 'list', 'swipe from the DM to the DM list');
  await page.click(`a[href^="/guild/${guildId}"]`);
  await page.waitForSelector('.guild-channel-link');
  await settle(page);
  check(await pane(page) === 'list' && path(page).startsWith(`/guild/${guildId}`), 'the guild opens on its channels');
  await swipeLeft();
  await settle(page);
  check(await pane(page) === 'content' && path(page).startsWith(`/guild/${guildId}/`), 'swipe left shows its channel');
  const channelPath = path(page);
  await swipeRight();
  await settle(page);
  await shot(page, '1-after-swipe-back');
  check(await pane(page) === 'list', 'swipe right shows the list');
  check(path(page) === channelPath, `still on the guild's channel (${path(page)})`);
  check(await showsChannels(), 'the list is the guild\'s channels, not the DMs');

  // Tapping the channel, then swiping back.
  await page.click('.guild-channel-link');
  await settle(page);
  check(await pane(page) === 'content', 'tapping the channel shows it');
  await swipeRight();
  await settle(page);
  check(await pane(page) === 'list' && path(page) === channelPath && await showsChannels(), 'swipe back: the guild\'s channels');

  // Swiping left again and back, twice over.
  for (let i = 0; i < 2; i++) {
    await swipeLeft();
    await settle(page);
    await swipeRight();
    await settle(page);
  }
  check(await pane(page) === 'list' && path(page) === channelPath && await showsChannels(), 'and again after swiping to and fro');

  // A reload on the guild's channel (a fresh start opens on the chat).
  await swipeLeft();
  await settle(page);
  await page.reload();
  await page.waitForSelector('.guild-channel-link');
  await settle(page);
  check(await pane(page) === 'content', 'a reload opens on the channel');
  await swipeRight();
  await settle(page);
  check(await pane(page) === 'list' && path(page) === channelPath && await showsChannels(), 'swipe back after a reload: the guild\'s channels');

  // The same from the DM side still goes back to the DMs.
  await page.click('a[href="/dm"]');
  await page.waitForSelector('#dm-sidebar');
  await settle(page);
  await page.click(`#dm-sidebar a[href="/dm/${alice.id}"]`);
  await settle(page);
  await swipeRight();
  await settle(page);
  check(await pane(page) === 'list' && path(page) === `/dm/${alice.id}`, 'a DM still swipes back to the DM list');

  console.log(failures ? `guildswipe: ${failures} FAILED` : 'guildswipe: ok');
  if (failures) process.exitCode = 1;
} catch (err) {
  console.error('guildswipe: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
