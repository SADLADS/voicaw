// The corner players (Layout's .corner-players), through the e2e LiveKit and real YouTube
// (Watch Together needs the internet; skipped with a note without it). Alice shares her screen,
// Bob watches, then opens #general: the stream carries on small in the bottom right corner
// (playing, no Live badge or full screen), "Go to the voice channel" takes him back (the corner
// goes, the stream is on the page), Stop watching there stops it, Pop out moves it to its own
// window (no corner) and closing that brings the corner back. Alice's own stream never shows
// in a corner. With a Watch Together video on too, the stream sits above its mini player
// without overlapping. Watch Together pops out into its own window (in step with Alice's), the
// channel page saying so; Bring back and closing the window put it back over the slot. A DM
// call's stream goes to the corner too ("Go to the call"). Carol on a phone gets it top right
// under the header.
//   node e2e/serve.mjs &   then   node e2e/streamcorner.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, devices, fakeMicArgs, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2] || '/home/otto/.claude/jobs/1cc60655/tmp/shots/corner';
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RICK = 'dQw4w9WgXcQ';
const CORNER = '.stream-view.corner';
const ON_PAGE = '.stream-view:not(.corner)';

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

// The stream under `selector` plays: frames decoded and its time moving on.
async function playing(page, selector) {
  await page.waitForFunction((s) => {
    const v = document.querySelector(`${s} video`);
    return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
  }, selector, { timeout: 20000 });
  const t = await page.$eval(`${selector} video`, (v) => v.currentTime);
  await sleep(1200);
  const later = await page.$eval(`${selector} video`, (v) => v.currentTime);
  if (!(later > t + 0.5)) throw new Error(`FAILED: ${selector} stopped (${t} → ${later})`);
  return page.$eval(`${selector} video`, (v) => `${v.videoWidth}x${v.videoHeight}`);
}

// Where an element is, measured after paint.
const rect = (page, selector) => page.evaluate((s) => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const el = document.querySelector(s);
      if (!el) return resolve(null);
      const r = el.getBoundingClientRect();
      resolve({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight });
    };
    ch.port2.postMessage(0);
  });
}), selector);

// The corner's bar: which buttons it has, and whether everything in it fits inside the corner.
const cornerBar = (page) => page.$eval(CORNER, (el) => {
  const box = el.getBoundingClientRect();
  const parts = [...el.querySelectorAll('.stream-bar > *')].map((p) => p.getBoundingClientRect());
  return {
    labels: [...el.querySelectorAll('.stream-bar button')].map((b) => b.getAttribute('aria-label')),
    live: Boolean(el.querySelector('.voice-live-badge')),
    volume: Boolean(el.querySelector('.stream-bar .stream-volume')),
    fits: parts.every((r) => r.width === 0 || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5)),
    oneLine: new Set(parts.filter((r) => r.width > 0).map((r) => Math.round(r.top + r.height / 2) >> 3)).size <= 2,
  };
});

// Does `action`, which should close window `w`.
async function closesWindow(w, action, timeout = 5000) {
  await Promise.all([w.waitForEvent('close', { timeout }), action()]);
}

// The YouTube frame's <video> in `page` (a window): { time, paused } or null.
async function ytVideo(page) {
  const frame = page.frames().find((f) => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  if (!frame) return null;
  return frame.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { time: v.currentTime, paused: v.paused } : null;
  }).catch(() => null);
}

async function waitYt(page, test, what, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await ytVideo(page);
    if (last && test(last)) return last;
    await sleep(250);
  }
  throw new Error(`FAILED: ${what} (last: ${JSON.stringify(last)})`);
}

const tile = (name) => `.voice-tile:has-text("${name}")`;

async function goLive(page) {
  await page.click('.voice-bar button[aria-label="Share your screen"]');
  await page.click('.go-live-dialog button:has-text("Go Live")');
  await page.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
}

async function youtubeReachable() {
  try {
    const res = await fetch(`https://www.youtube-nocookie.com/embed/${RICK}`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

const browser = await launchChrome({ args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen'] });
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
  await makeFriends(alice, bob, carol);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Corner Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  const guildId = /\/guild\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const channelId = /\/guild\/\d+\/(\d+)/.exec(a.url())[1];
  const loungePath = `/guild/${guildId}/${channelId}`;

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  await goLive(a);
  await b.waitForSelector(`${tile(alice.name)} .voice-live-badge`, { timeout: 10000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await playing(b, ON_PAGE);
  check(!(await b.$(CORNER)), 'watching on the channel page: no corner');

  // Bob opens #general: the stream carries on in the bottom right corner.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector(CORNER, { timeout: 5000 });
  check(!(await b.$(ON_PAGE)), 'on #general the stream is only in the corner');
  const size = await playing(b, CORNER);
  check(true, `the corner's video plays (${size}, time moving)`);
  const r = await rect(b, CORNER);
  console.log('corner:', JSON.stringify(r));
  check(Math.abs(r.width - 320) < 1 && Math.abs(r.width / r.height - 16 / 9) < 0.03, `320 px wide, 16:9 (${r.width}×${r.height.toFixed(1)})`);
  check(Math.abs(r.vw - 16 - r.right) < 1.5 && Math.abs(r.vh - 16 - r.bottom) < 1.5, 'bottom right, 16 px in');
  const bar = await cornerBar(b);
  console.log('corner bar:', JSON.stringify(bar));
  check(!bar.live && !bar.labels.includes('Full screen'), 'no Live badge, no Full screen');
  check(['Go to the voice channel', 'Pop out', 'Stop watching'].every((l) => bar.labels.includes(l)) && bar.volume, 'volume, Go to the voice channel, Pop out, Stop watching');
  check(bar.fits && bar.oneLine, 'the bar fits inside the corner on one line');
  await shot(b, '01-corner-stream');

  // Alice's own stream never goes to her corner.
  await a.click('.guild-channel-link:has-text("general")');
  await a.waitForSelector('#dm-input');
  await sleep(1500);
  check(!(await a.$('.stream-view')), "the sharer's own stream isn't in her corner");
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-view-controls');

  // Go to the voice channel: back on its page, the corner goes, the stream is on the page.
  await b.click(`${CORNER} button[aria-label="Go to the voice channel"]`);
  await b.waitForURL((u) => u.pathname === loungePath);
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  await playing(b, ON_PAGE);
  check(true, 'Go to the voice channel: its page, the stream back on it, no corner');

  // Stop watching from the corner.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector(CORNER);
  await b.click(`${CORNER} button[aria-label="Stop watching"]`);
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  await sleep(800);
  check(!(await b.$('.stream-view')), 'Stop watching in the corner stops it');
  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector(tile(alice.name));
  await sleep(800);
  check(!(await b.$('.stream-view')), 'and the channel page has no stream either');

  // Pop out from the corner: a window, no corner; closing it brings the corner back.
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await playing(b, ON_PAGE);
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector(CORNER);
  const [sw] = await Promise.all([
    b.context().waitForEvent('page'),
    b.click(`${CORNER} button[aria-label="Pop out"]`),
  ]);
  await sw.waitForSelector('.stream-view.popped-out');
  await playing(sw, '.stream-view.popped-out');
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  check(await sw.evaluate(() => document.body.classList.contains('popout-window') && Boolean(document.querySelector('.popout-window-root'))), 'Pop out from the corner: its own window (popout-window), corner gone');
  await sw.close();
  await b.waitForSelector(CORNER, { timeout: 5000 });
  await playing(b, CORNER);
  check(true, 'closing the window brings the corner back (still on #general)');

  // Watch Together too: the stream above its mini player, not overlapping.
  const internet = await youtubeReachable();
  if (!internet) {
    console.log('SKIPPED: YouTube unreachable, no Watch Together checks');
  } else {
    // Alice watches her own stream (a sharer's preview): that takes the page; stop it first.
    if (await a.$('.stream-view')) await a.click('.stream-view button[aria-label="Stop watching"]');
    await a.click('.watch-party-toggle');
    await a.waitForSelector('.watch-party-panel .watch-party-empty');
    await a.fill('.watch-party-add input', `https://www.youtube.com/watch?v=${RICK}`);
    await a.click('.watch-party-add button[type="submit"]');
    await a.waitForSelector('.watch-party-player.docked iframe', { timeout: 15000 });
    await b.waitForSelector('.watch-party-player.mini iframe', { timeout: 15000 });
    await waitYt(b, (v) => !v.paused && v.time > 1, 'bob plays Watch Together in the corner');
    await playing(b, CORNER);
    const s = await rect(b, CORNER);
    const w = await rect(b, '.watch-party-player.mini');
    console.log('stream:', JSON.stringify(s), '\nwatch together:', JSON.stringify(w));
    check(s.bottom <= w.top + 0.5, `the stream sits above Watch Together, not overlapping (${s.bottom.toFixed(1)} ≤ ${w.top.toFixed(1)})`);
    check(Math.abs(s.right - w.right) < 1, 'right edges line up');
    for (const [name, q] of [['stream', s], ['watch together', w]]) {
      check(q.top >= 0 && q.left >= 0 && q.right <= q.vw && q.bottom <= q.vh, `${name} inside the viewport`);
    }
    check(await b.isVisible('.watch-party-mini-bar button[aria-label="Pop out"]'), 'the mini player has Pop out');
    await shot(b, '02-stream-and-watch-together');

    // Back on the channel page the stream takes the page and Watch Together stays in the corner.
    await b.click('.guild-channel-link:has-text("lounge")');
    await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
    await playing(b, ON_PAGE);
    await b.waitForSelector('.watch-party-player.mini iframe');
    check(true, 'channel page: the stream on the page, Watch Together in the corner');
    await shot(b, '02b-channel-page-stream-and-mini');

    // While a page shows the stream, the corner column goes top right under the header, clear
    // of the stream's bar and the voice controls.
    check(await b.$eval('.corner-players', (el) => el.classList.contains('top')), 'the corner column has class top');
    const mini = await rect(b, '.watch-party-player.mini');
    const header = await b.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vc-header-height')));
    console.log('mini on the channel page:', JSON.stringify(mini), 'header', header);
    check(Math.abs(mini.top - (header + 16)) < 1.5 && Math.abs(mini.vw - 16 - mini.right) < 1.5, `top right under the header (top ${mini.top}, right ${mini.right} of ${mini.vw})`);
    const blocked = await b.evaluate(() => {
      const hidden = [];
      for (const el of document.querySelectorAll('.stream-view:not(.corner) .stream-bar button, .voice-view-controls button')) {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el.contains(top)) hidden.push(el.getAttribute('aria-label'));
      }
      return hidden;
    });
    check(blocked.length === 0, `nothing in the stream bar or the voice controls is covered (${blocked.join(', ') || 'none'})`);

    // Watch Together popped out from the docked player (Bob stops watching the stream with its
    // own Stop watching, now clickable: the player docks over its slot).
    await b.click(`${ON_PAGE} button[aria-label="Stop watching"]`, { timeout: 5000 });
    await b.waitForSelector('.watch-party-player.docked iframe', { timeout: 10000 });
    const [ww] = await Promise.all([
      b.context().waitForEvent('page'),
      b.click('.watch-party-controls button[aria-label="Pop out"]'),
    ]);
    await ww.waitForSelector('.watch-party-player.popped-out iframe', { timeout: 15000 });
    check(true, 'Pop out: a window with the player (popped-out) and its YouTube frame');
    const note = await b.textContent('.watch-party-popped', { timeout: 5000 });
    check(note.includes('Playing in its own window.') && note.includes('Bring back'), `the channel page says so ("${note}")`);
    check(!(await b.$('.watch-party-player')), 'no player left on the page');
    await waitYt(ww, (v) => !v.paused && v.time > 1, 'the popped-out player plays', 30000);
    let inStep = false;
    let last;
    for (let i = 0; i < 30 && !inStep; i++) {
      const [ta, tw] = await Promise.all([ytVideo(a), ytVideo(ww)]);
      last = `alice ${ta?.time.toFixed(2)} s, window ${tw?.time.toFixed(2)} s${tw?.paused ? ' (paused)' : ''}`;
      if (process.env.DEBUG_SYNC) console.log('sync', last);
      // Each player is moved back only when over 2 s off the server's clock (useWatchPartySync
      // DRIFT_PLAYING), so two can be up to 4 s apart and still count as in step.
      inStep = ta && tw && !tw.paused && Math.abs(ta.time - tw.time) < 4;
      if (!inStep) await sleep(500);
    }
    check(inStep, `the window plays in step with the party (${last})`);
    const fill = await ww.evaluate(() => {
      const p = document.querySelector('.watch-party-player.popped-out').getBoundingClientRect();
      const f = document.querySelector('.watch-party-player.popped-out iframe').getBoundingClientRect();
      return { player: `${p.width}x${p.height}`, frame: `${f.width}x${f.height}`, window: `${innerWidth}x${innerHeight}`, title: document.title, fills: p.width === innerWidth && p.height === innerHeight };
    });
    console.log('watch together window:', JSON.stringify(fill));
    check(fill.fills, 'the player fills the window');
    check(await ww.isVisible('.watch-party-player button[aria-label="Bring back"]'), 'the window has Bring back');
    await shot(ww, '03-watch-together-window');
    await shot(b, '04-channel-page-note');

    await closesWindow(ww, () => ww.click('.watch-party-player button[aria-label="Bring back"]'));
    await b.waitForSelector('.watch-party-player.docked iframe', { timeout: 5000 });
    const placed = await b.evaluate(() => {
      const s = document.querySelector('.watch-party-slot').getBoundingClientRect();
      const p = document.querySelector('.watch-party-player').getBoundingClientRect();
      return Math.abs(s.left - p.left) + Math.abs(s.top - p.top) + Math.abs(s.width - p.width) + Math.abs(s.height - p.height);
    });
    check(placed < 2, `Bring back closes the window, the player is back over the slot (off by ${placed.toFixed(1)} px)`);
    await waitYt(b, (v) => !v.paused && v.time > 1, 'plays again on the page', 30000);

    const [ww2] = await Promise.all([
      b.context().waitForEvent('page'),
      b.click('.watch-party-controls button[aria-label="Pop out"]'),
    ]);
    await ww2.waitForSelector('.watch-party-player.popped-out iframe', { timeout: 15000 });
    await ww2.close();
    await b.waitForSelector('.watch-party-player.docked iframe', { timeout: 5000 });
    check(!(await b.$('.watch-party-popped')), 'closing the window by hand puts it back docked');

    // From the mini player's bar too (watching the stream again); the party ending closes the window.
    await b.click(`${tile(alice.name)} .voice-tile-watch`);
    await playing(b, ON_PAGE);
    await b.click('.guild-channel-link:has-text("general")');
    await b.waitForSelector(CORNER);
    await b.waitForSelector('.watch-party-player.mini');
    const [ww3] = await Promise.all([
      b.context().waitForEvent('page'),
      b.click('.watch-party-mini-bar button[aria-label="Pop out"]'),
    ]);
    await ww3.waitForSelector('.watch-party-player.popped-out iframe', { timeout: 15000 });
    check(!(await b.$('.watch-party-player')), "Pop out from the mini player: it's in the window, not the corner");
    check(Boolean(await b.$(CORNER)), 'the stream stays in the corner meanwhile');
    await closesWindow(ww3, () => a.click('.watch-party-controls button[aria-label="Skip"]'), 10000);
    check(true, 'the party ending closes the window');
  }

  // Off the channel: Bob leaves voice, Alice stops.
  await b.click('.voice-bar button[aria-label="Disconnect"]');
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  check(true, 'leaving voice: no corner');

  // Carol on a phone: top right, under the header.
  await c.goto(`${BASE}${loungePath}`);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls', { timeout: 20000 });
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await playing(c, ON_PAGE);
  await c.goBack(); // the channel list (phone panes)
  await sleep(600);
  await c.click('.guild-channel-link:has-text("general")');
  await c.waitForSelector(CORNER, { timeout: 5000 });
  await sleep(600); // the panes' slide
  await playing(c, CORNER);
  const pr = await rect(c, CORNER);
  const header = await c.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vc-header-height')));
  console.log('phone corner:', JSON.stringify(pr), 'header', header);
  check(Math.abs(pr.width - 200) < 1, `200 px wide (${pr.width})`);
  check(Math.abs(pr.top - (header + 8)) < 2 && Math.abs(pr.vw - 8 - pr.right) < 1.5, `top right under the header (top ${pr.top}, right ${pr.right} of ${pr.vw})`);
  check(pr.left >= 0 && pr.bottom <= pr.vh, 'fits the phone');
  const pbar = await cornerBar(c);
  console.log('phone corner bar:', JSON.stringify(pbar));
  check(pbar.fits, 'the bar fits inside it');
  const pname = await c.$eval(`${CORNER} .stream-name`, (el) => ({ text: el.textContent, scroll: el.scrollWidth, client: el.clientWidth }));
  check(pname.text === alice.name && pname.scroll <= pname.client, `the name isn't cut short (${JSON.stringify(pname)})`);
  check(!(await c.$(`${CORNER} .stream-volume-slider`)) || !(await c.isVisible(`${CORNER} .stream-volume-slider`)), 'no volume slider on a phone (mute stays)');
  check(pbar.labels.includes('Mute the stream'), 'the mute button stays');
  check(!pbar.labels.includes('Pop out'), 'no Pop out on a phone');
  await shot(c, '05-phone-corner');
  await c.click('.voice-bar button[aria-label="Disconnect"], button[aria-label="Disconnect"]').catch(() => {});

  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await a.click('.voice-bar button[aria-label="Disconnect"]');

  // A DM call: Bob watches Alice's screen, opens the guild: the corner, "Go to the call".
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await a.click('.call-panel button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await b.waitForSelector('.call-panel .stream-view', { timeout: 15000 });
  await playing(b, '.call-panel .stream-view');
  await b.click(`.rail-guild[href="/guild/${guildId}"]`);
  await b.waitForSelector(CORNER, { timeout: 8000 });
  await playing(b, CORNER);
  const cbar = await cornerBar(b);
  check(cbar.labels.includes('Go to the call'), "a call's stream in the corner: Go to the call");
  await shot(b, '06-call-corner');
  await b.click(`${CORNER} button[aria-label="Go to the call"]`);
  await b.waitForURL((u) => u.pathname === `/dm/${alice.id}`);
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  await playing(b, '.call-panel .stream-view');
  check(true, 'Go to the call: the DM, its call panel shows the stream, no corner');
  await b.click('.call-panel button[aria-label="Hang up"]');

  console.log('\nALL PASSED');
} catch (e) {
  for (const ctx of browser.contexts()) {
    for (const [i, page] of ctx.pages().entries()) await page.screenshot({ path: `${shots}/fail-${browser.contexts().indexOf(ctx)}-${i}.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
}
