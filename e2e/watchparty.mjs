// Watch Together in real browsers, with real YouTube videos (needs the internet): Alice (the
// owner) and Bob join a voice channel; Alice opens Watch Together and pastes links. Both play the
// same video at the same point (measured inside YouTube's frames), pause, seek and skip follow
// her, the queue reorders by dragging (Manage Queue: Alice yes, Bob no), Bob removes only his
// own, the 19 s first video moves on by itself, the player keeps playing small in a corner on
// another page, the channel list says what's on, and Carol on a phone sees it docked.
//   node e2e/serve.mjs &   then   node e2e/watchparty.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ZOO = 'jNQXAC9IVRw'; // "Me at the zoo", 19 s
const RICK = 'dQw4w9WgXcQ';
const GANGNAM = '9bZkp7q19f0';

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

// The YouTube frame's <video>: { id, time, paused } (null until there is one).
async function video(page) {
  const frame = page.frames().find((f) => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  if (!frame) return null;
  return frame.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const id = new URL(location.href).pathname.split('/')[2];
    return { time: v.currentTime, paused: v.paused, src: Boolean(v.src), id, url: document.querySelector('.ytp-title-link')?.href ?? null };
  }).catch(() => null);
}

async function waitVideo(page, test, what, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await video(page);
    if (last && test(last)) return last;
    await sleep(250);
  }
  throw new Error(`FAILED: ${what} (last: ${JSON.stringify(last)})`);
}

const addLink = async (page, link) => {
  await page.fill('.watch-party-add input', link);
  await page.click('.watch-party-add button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('.watch-party-add input')?.value, null, { timeout: 15000 });
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Watch Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Cinema');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const cinemaUrl = a.url();

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("cinema")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  console.log('alice and bob in voice');

  // Bob, not yet in Watch Together, sees no player; Alice opens it.
  await a.click('.watch-party-toggle');
  await a.waitForSelector('.watch-party-panel .watch-party-empty');
  await shot(a, '01-empty');
  await addLink(a, `https://youtu.be/${ZOO}`);
  await a.waitForSelector('.watch-party-player.docked iframe');
  await b.waitForSelector('.watch-party-player.docked iframe', { timeout: 10000 });
  check(true, 'the first video opens the player for everyone in voice');

  // Docked exactly over the page's slot.
  const placed = await a.evaluate(() => {
    const s = document.querySelector('.watch-party-slot').getBoundingClientRect();
    const p = document.querySelector('.watch-party-player').getBoundingClientRect();
    return Math.abs(s.left - p.left) + Math.abs(s.top - p.top) + Math.abs(s.width - p.width) + Math.abs(s.height - p.height);
  });
  check(placed < 2, `the player sits over its slot (off by ${placed.toFixed(1)} px)`);

  // 16:9 (plus the controls bar) whether the queue sits beside it or, narrow, under it.
  const shape = () => a.evaluate(() => {
    const p = document.querySelector('.watch-party-player').getBoundingClientRect();
    const side = document.querySelector('.watch-party-side').getBoundingClientRect();
    return { ratio: p.width / (p.height - 44), below: side.top >= p.bottom - 1, width: p.width };
  });
  const narrow = await shape();
  check(Math.abs(narrow.ratio - 16 / 9) < 0.05 && narrow.below, `narrow page: 16:9 with the queue under it (${JSON.stringify(narrow)})`);
  await a.setViewportSize({ width: 1600, height: 900 });
  await sleep(300);
  const wide = await shape();
  check(Math.abs(wide.ratio - 16 / 9) < 0.05 && !wide.below, `wide page: 16:9 with the queue beside it (${JSON.stringify(wide)})`);
  await shot(a, '01b-wide');
  await a.setViewportSize({ width: 1100, height: 750 });

  await addLink(a, `https://www.youtube.com/watch?v=${RICK}`);
  await addLink(b, `https://www.youtube.com/watch?v=${GANGNAM}`);
  await a.waitForFunction(() => document.querySelectorAll('.watch-party-item').length === 2);
  const nowTitle = await a.textContent('.watch-party-now .watch-party-item-title');
  const titles = await a.$$eval('.watch-party-item .watch-party-item-title', (els) => els.map((e) => e.textContent));
  console.log('playing:', nowTitle, 'queue:', titles);
  check(nowTitle === 'Me at the zoo', 'titles come from YouTube');

  // Both play, in step.
  const va = await waitVideo(a, (v) => !v.paused && v.time > 2, 'alice plays');
  const vb = await waitVideo(b, (v) => !v.paused && v.time > 2, 'bob plays');
  console.log('alice', va, 'bob', vb);
  const [ta, tb] = await Promise.all([video(a), video(b)]);
  check(Math.abs(ta.time - tb.time) < 1.5, `in step (alice ${ta.time.toFixed(2)} s, bob ${tb.time.toFixed(2)} s)`);
  await shot(a, '02-playing');

  // Alice pauses: Bob's pauses at the same point.
  await a.click('.watch-party-controls button[aria-label="Pause"]');
  await waitVideo(b, (v) => v.paused, 'bob pauses with alice', 5000);
  const [pa, pb] = await Promise.all([video(a), video(b)]);
  check(Math.abs(pa.time - pb.time) < 1, `paused at the same point (${pa.time.toFixed(2)} / ${pb.time.toFixed(2)})`);
  await b.waitForSelector('.watch-party-paused');
  await b.waitForSelector('.guild-channel-watch:has-text("Paused")');
  check(true, 'the channel list says it is paused');

  // Seek back to the start (keyboard on the seek bar) while paused, then play.
  await a.focus('.watch-party-seek');
  await a.keyboard.press('Home');
  await waitVideo(b, (v) => v.paused && v.time < 1, 'bob seeks to the start while paused', 5000);
  await a.click('.watch-party-controls button[aria-label="Play"]');
  await waitVideo(b, (v) => !v.paused && v.time > 0.3, 'bob plays again', 8000);

  // Queue: Alice (owner) drags; Bob has no grips and removes only his own.
  check(await b.$$eval('.watch-party-grip', (els) => els.length) === 0, 'bob (no Manage Queue) has no drag handles');
  const bobRemove = await b.$$eval('.watch-party-item', (items) => items.map((i) => Boolean(i.querySelector('button[aria-label="Remove from the queue"]'))));
  check(bobRemove.join() === 'false,true', 'bob can remove only the video he added');
  await shot(a, '02b-queue');
  await a.$eval('.watch-party-queue', (el) => el.scrollIntoView({ block: 'end' }));
  const items = await a.$$('.watch-party-item');
  const from = await items[1].boundingBox();
  const to = await items[0].boundingBox();
  await a.mouse.move(from.x + 40, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(from.x + 40, from.y + from.height / 2 - 10, { steps: 3 });
  await a.mouse.move(to.x + 40, to.y + 4, { steps: 8 });
  await a.mouse.up();
  await b.waitForFunction((t) => document.querySelector('.watch-party-item .watch-party-item-title')?.textContent !== t, titles[0], { timeout: 5000 });
  const reordered = await b.$$eval('.watch-party-item .watch-party-item-title', (els) => els.map((e) => e.textContent));
  console.log('after drag:', reordered);
  check(reordered[0] === titles[1] && reordered[1] === titles[0], 'a drag reorders the queue for everyone');

  // Bob goes to the text channel: the player carries on small in a corner.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector('.watch-party-player.mini');
  const miniPlaying = await waitVideo(b, (v) => !v.paused, 'still playing in the corner', 5000);
  check(Boolean(miniPlaying), 'the video keeps playing on another page');
  await shot(b, '03-mini-player');

  // The 19 s video ends: the server moves on by itself (Bob's added video was dragged first).
  await a.waitForFunction((t) => document.querySelector('.watch-party-now .watch-party-item-title')?.textContent === t, reordered[0], { timeout: 40000 });
  check(true, `moved on by itself to "${reordered[0]}"`);
  await waitVideo(b, (v) => !v.paused && v.time > 1, 'bob plays the next video in the corner', 20000);

  // Skip: the last one plays, and skipping that ends the party.
  await a.click('.watch-party-controls button[aria-label="Skip"]');
  await a.waitForFunction((t) => document.querySelector('.watch-party-now .watch-party-item-title')?.textContent === t, reordered[1], { timeout: 10000 });
  check(true, 'skip plays the next video');

  // Carol on a phone joins from the page and sees it docked.
  await c.goto(cinemaUrl);
  await c.waitForSelector('.watch-party-banner', { timeout: 10000 });
  check(true, 'outside voice, the page says what is playing');
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls', { timeout: 20000 });
  await c.waitForSelector('.watch-party-player.docked iframe', { timeout: 10000 });
  await waitVideo(c, (v) => !v.paused && v.time > 1, 'carol plays on her phone', 20000);
  const [ca, cc] = await Promise.all([video(a), video(c)]);
  check(Math.abs(ca.time - cc.time) < 2, `phone in step (${ca.time.toFixed(2)} / ${cc.time.toFixed(2)})`);
  await shot(c, '04-phone');
  await shot(a, '05-desktop-queue');

  await a.click('.watch-party-controls button[aria-label="Skip"]');
  await a.waitForSelector('.watch-party-player', { state: 'detached', timeout: 10000 });
  await c.waitForSelector('.watch-party-player', { state: 'detached', timeout: 10000 });
  await b.waitForFunction(() => !document.querySelector('.guild-channel-watch'));
  check(true, 'skipping the last video ends it for everyone');
  console.log('\nALL PASSED');
} finally {
  await browser.close();
}
