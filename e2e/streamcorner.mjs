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
// under the header. The corner players drag as one (from a picture or the mini player's bar,
// not a button; under 6 px is a click) and snap to the nearest of the four corners, kept after
// a reload; a bottom corner shows at the top while a page shows the stream; the docked player
// doesn't drag; on a phone a finger drags it without scrolling the page.
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

// ---- Dragging the corner players (hooks/useCornerDrag.js) ----
const COLUMN = '.corner-players';
const cornerOf = (page) => page.$eval(COLUMN, (el) => {
  const c = [...el.classList].find((k) => k.startsWith('at-'));
  return { corner: c?.slice(3) ?? null, dragging: el.classList.contains('dragging') };
});

// Where the column must sit in `corner` (desktop 16 px in, top ones under the header; phone 8).
async function checkPlaced(page, corner, what, phone = false) {
  const st = await cornerOf(page);
  const col = await rect(page, COLUMN);
  const header = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vc-header-height')));
  const gap = phone ? 8 : 16;
  const [y, x] = corner.split('-');
  const okY = y === 'top' ? Math.abs(col.top - (header + gap)) < 1.5 : Math.abs(col.vh - gap - col.bottom) < 1.5;
  // On a computer the left corners keep to the content pane (clear of the rail, channel list,
  // voice bar and user panel).
  const paneLeft = phone ? 0 : await page.$eval('.main-content-wrapper', (el) => el.getBoundingClientRect().left);
  const okX = x === 'left' ? Math.abs(col.left - (paneLeft + gap)) < 1.5 : Math.abs(col.vw - gap - col.right) < 1.5;
  const covers = phone ? [] : await page.evaluate(() => {
    const hidden = [];
    for (const el of document.querySelectorAll('.voice-bar button, .user-panel button, .user-panel a, .guild-channel-link, .sidebar-resizer')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top?.closest('.corner-players')) hidden.push(el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20));
    }
    return hidden;
  });
  if (covers.length) throw new Error(`FAILED: ${what}: the corner players cover ${covers.join(', ')}`);
  // Every player in it stacked, inside the viewport, aligned to the corner's side.
  const kids = await page.$$eval(`${COLUMN} > *:not(.docked)`, (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cls: e.className };
  }));
  const vw = col.vw;
  const vh = col.vh;
  const inside = kids.every((k) => k.left >= 0 && k.top >= 0 && k.right <= vw + 0.5 && k.bottom <= vh + 0.5);
  const stacked = kids.every((k, i) => i === 0 || kids[i - 1].bottom <= k.top + 0.5);
  const aligned = kids.every((k) => (x === 'left' ? Math.abs(k.left - col.left) < 1 : Math.abs(k.right - col.right) < 1));
  check(st.corner === corner && !st.dragging && okY && okX && inside && stacked && aligned,
    `${what}: at-${corner}, column ${Math.round(col.left)},${Math.round(col.top)}–${Math.round(col.right)},${Math.round(col.bottom)} of ${vw}×${vh} (header ${header}${x === 'left' && !phone ? `, content pane from ${paneLeft}` : ''}); ${kids.length} player(s) stacked, inside, ${x}-aligned`);
}

// A mouse drag from (x, y) to (tx, ty) in `steps`; halfway, the column must be `dragging` and
// have moved with the pointer (clamped to the viewport). Returns what it saw halfway.
async function mouseDrag(page, [x, y], [tx, ty], { steps = 14, expectFollow = true } = {}) {
  const before = await rect(page, COLUMN);
  await page.mouse.move(x, y);
  await page.mouse.down();
  let mid = null;
  for (let i = 1; i <= steps; i++) {
    const px = x + ((tx - x) * i) / steps;
    const py = y + ((ty - y) * i) / steps;
    await page.mouse.move(px, py);
    if (i === Math.floor(steps / 2)) {
      const now = await rect(page, COLUMN);
      const st = await cornerOf(page);
      const wantLeft = Math.min(Math.max(before.left + px - x, 0), before.vw - before.width);
      const wantTop = Math.min(Math.max(before.top + py - y, 0), before.vh - before.height);
      mid = { dragging: st.dragging, follows: Math.abs(now.left - wantLeft) < 2 && Math.abs(now.top - wantTop) < 2, now, wantLeft, wantTop };
    }
  }
  await page.mouse.up();
  await sleep(250);
  if (expectFollow && !(mid.dragging && mid.follows)) throw new Error(`FAILED: mid-drag the column follows the pointer (${JSON.stringify(mid)})`);
  return mid;
}

// A point on the corner stream's picture (above its bar), or the mini player's title.
async function grabPoint(page, which = 'stream') {
  const r = which === 'stream' ? await rect(page, CORNER) : await rect(page, '.watch-party-mini-title');
  return which === 'stream' ? [r.left + r.width / 2, r.top + r.height * 0.3] : [r.left + r.width / 2, r.top + r.height / 2];
}

// Pointer targets that put the column's middle in each corner's quarter.
const targetFor = (corner, vw, vh) => {
  const [y, x] = corner.split('-');
  return [x === 'left' ? vw * 0.2 : vw * 0.8, y === 'top' ? vh * 0.25 : vh * 0.8];
};

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

  // Dragging the corner stream (from its picture) to each corner in turn: it follows the
  // pointer, then snaps to the corner nearest its middle.
  await checkPlaced(b, 'bottom-right', 'by default');
  const vp = b.viewportSize();
  for (const corner of ['bottom-left', 'top-left', 'top-right', 'bottom-right']) {
    await mouseDrag(b, await grabPoint(b), targetFor(corner, vp.width, vp.height));
    await checkPlaced(b, corner, `dragged to ${corner} (followed the pointer, dragging class)`);
  }
  await mouseDrag(b, await grabPoint(b), [vp.width * 0.4, vp.height * 0.4]);
  await checkPlaced(b, 'top-left', 'dropped a little up and left of the middle: snaps top left');
  await shot(b, '01b-corner-top-left');

  // A move under 6 px is a click, not a drag; a press on a button doesn't drag either.
  const still = await rect(b, COLUMN);
  const [gx, gy] = await grabPoint(b);
  await b.mouse.move(gx, gy);
  await b.mouse.down();
  await b.mouse.move(gx + 3, gy + 2, { steps: 3 });
  const tiny = await cornerOf(b);
  await b.mouse.up();
  const afterTiny = await rect(b, COLUMN);
  check(!tiny.dragging && afterTiny.left === still.left && afterTiny.top === still.top && (await cornerOf(b)).corner === 'top-left', 'a 3 px move does nothing');
  const muteSel = `${CORNER} .stream-volume button`;
  const pressedBefore = await b.getAttribute(muteSel, 'aria-pressed');
  const mb = await rect(b, muteSel);
  await b.mouse.move(mb.left + mb.width / 2, mb.top + mb.height / 2);
  await b.mouse.down();
  await b.mouse.move(mb.left + 200, mb.top + 250, { steps: 10 });
  const onButton = await cornerOf(b);
  await b.mouse.up();
  const afterButton = await rect(b, COLUMN);
  check(!onButton.dragging && afterButton.left === still.left && afterButton.top === still.top, 'a drag starting on the mute button moves nothing');
  check(await b.getAttribute(muteSel, 'aria-pressed') === pressedBefore, "and doesn't press it (released elsewhere)");
  const sb = await rect(b, `${CORNER} button[aria-label="Stop watching"]`);
  await b.mouse.move(sb.left + sb.width / 2, sb.top + sb.height / 2);
  await b.mouse.down();
  await b.mouse.move(sb.left + 250, sb.top + 300, { steps: 10 });
  const onStop = await cornerOf(b);
  await b.mouse.up();
  check(!onStop.dragging && (await cornerOf(b)).corner === 'top-left' && Boolean(await b.$(CORNER)), 'a drag starting on Stop watching moves nothing (and still watching)');

  // Back to bottom right; the click right after a drag (Pop out) still works.
  await mouseDrag(b, await grabPoint(b), targetFor('bottom-right', vp.width, vp.height));
  await checkPlaced(b, 'bottom-right', 'dragged back to bottom right');
  const [sw] = await Promise.all([
    b.context().waitForEvent('page'),
    b.click(`${CORNER} button[aria-label="Pop out"]`),
  ]);
  await sw.waitForSelector('.stream-view.popped-out');
  await playing(sw, '.stream-view.popped-out');
  await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
  check(await sw.evaluate(() => document.body.classList.contains('popout-window') && Boolean(document.querySelector('.popout-window-root'))), 'Pop out clicked right after a drag works: its own window (popout-window), corner gone');
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

    // Dragged from the mini player's bar, both move as one, stacked, in every corner.
    for (const corner of ['top-right', 'top-left', 'bottom-left']) {
      await mouseDrag(b, await grabPoint(b, 'mini'), targetFor(corner, vp.width, vp.height));
      await checkPlaced(b, corner, `both dragged by the mini player to ${corner}`);
      if (corner === 'top-left') await shot(b, '02c-both-top-left');
    }
    // From the mini player's picture too (its shield, over YouTube's frame).
    const shield = await rect(b, '.watch-party-player.mini .watch-party-shield');
    await mouseDrag(b, [shield.left + shield.width / 2, shield.top + shield.height / 2], targetFor('bottom-right', vp.width, vp.height));
    await checkPlaced(b, 'bottom-right', "both dragged by the mini player's picture to bottom-right");
    await mouseDrag(b, await grabPoint(b), targetFor('bottom-left', vp.width, vp.height));
    await checkPlaced(b, 'bottom-left', 'both dragged by the stream to bottom-left');
    await shot(b, '02d-both-bottom-left');

    // Back on the channel page the stream takes the page and Watch Together stays in the corner.
    await b.click('.guild-channel-link:has-text("lounge")');
    await b.waitForSelector(CORNER, { state: 'detached', timeout: 5000 });
    await playing(b, ON_PAGE);
    await b.waitForSelector('.watch-party-player.mini iframe');
    check(true, 'channel page: the stream on the page, Watch Together in the corner');
    await shot(b, '02b-channel-page-stream-and-mini');

    // While a page shows the stream, a bottom corner shows as the top one on its side (stored
    // bottom-left → top left under the header), clear of the stream's bar and the voice controls.
    await checkPlaced(b, 'top-left', 'channel page showing the stream, stored bottom-left');
    check(await b.evaluate(() => localStorage.getItem('pipCorner')) === 'bottom-left', 'still stored as bottom-left');
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
    await checkPlaced(b, 'bottom-left', 'stream no longer on the page: back to the stored bottom-left');
    // The docked player (over its slot) isn't dragged.
    const dockedBefore = await rect(b, '.watch-party-player.docked');
    const ds = await rect(b, '.watch-party-player.docked .watch-party-shield');
    const dragDocked = await mouseDrag(b, [ds.left + ds.width / 2, ds.top + ds.height / 2], [ds.left + 40, ds.top + 300], { expectFollow: false });
    const dockedAfter = await rect(b, '.watch-party-player.docked');
    check(!dragDocked.dragging && dockedAfter.left === dockedBefore.left && dockedAfter.top === dockedBefore.top && (await cornerOf(b)).corner === 'bottom-left',
      'a drag on the docked player does nothing (not dragging, same place, corner unchanged)');
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
    await b.waitForSelector('.watch-party-player.mini iframe');
    // Stored bottom-left shows top left here, beside the channel list: #general is clickable.
    await checkPlaced(b, 'top-left', 'channel page, stored bottom-left (left corner clear of the sidebar)');
    await b.click('.guild-channel-link:has-text("general")', { timeout: 5000 });
    check(true, '#general clicked with the column at top left');
    await b.waitForSelector(CORNER);
    await b.waitForSelector('.watch-party-player.mini');
    await checkPlaced(b, 'bottom-left', 'on #general both at the stored bottom left');

    // It follows the sidebar's width (Shift+ArrowRight on its resizer: 40 px wider).
    const paneBefore = await b.$eval('.main-content-wrapper', (el) => el.getBoundingClientRect().left);
    await b.focus('.sidebar-resizer');
    await b.keyboard.press('Shift+ArrowRight');
    await b.waitForFunction((x) => document.querySelector('.main-content-wrapper').getBoundingClientRect().left > x + 30, paneBefore);
    await sleep(200);
    await checkPlaced(b, 'bottom-left', 'after widening the sidebar by 40 px, still beside it');
    await b.dblclick('.sidebar-resizer');
    await b.waitForFunction((x) => Math.abs(document.querySelector('.main-content-wrapper').getBoundingClientRect().left - x) < 1, paneBefore);
    await sleep(200);
    await checkPlaced(b, 'bottom-left', 'sidebar back to its default width');

    // Settings (its own column beside the rail): still beside it.
    await b.click('.user-panel-settings');
    await b.waitForURL((u) => u.pathname.startsWith('/settings'));
    await sleep(500);
    await checkPlaced(b, 'bottom-left', 'on Settings');
    await shot(b, '02e-settings-bottom-left');
    await b.goBack();
    await b.waitForSelector('#dm-input');
    await b.waitForSelector(CORNER);

    // To top right (stored, for the reload check later).
    await mouseDrag(b, await grabPoint(b, 'mini'), targetFor('top-right', vp.width, vp.height));
    await b.waitForSelector(CORNER);
    await b.waitForSelector('.watch-party-player.mini');
    await checkPlaced(b, 'top-right', 'on #general both at the stored top right');
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

  // A finger drags it from top right to bottom left: 8 px in, and the page doesn't move.
  await checkPlaced(c, 'top-right', 'phone default', true);
  const cdp = await c.context().newCDPSession(c);
  const pv = c.viewportSize();
  const [fx, fy] = await grabPoint(c);
  const [tx, ty] = targetFor('bottom-left', pv.width, pv.height);
  const pageState = () => c.evaluate(() => ({
    scroll: document.scrollingElement.scrollTop,
    scroller: document.querySelector('.message-scroller')?.scrollTop ?? null,
    panes: [...document.querySelector('.main-wrapper').classList].filter((k) => k.startsWith('pane')).join(' '),
    url: location.pathname,
  }));
  const before = await pageState();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', fx, fy);
  const steps = 16;
  let midTouch = null;
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', fx + ((tx - fx) * i) / steps, fy + ((ty - fy) * i) / steps);
    await sleep(16);
    if (i === steps / 2) midTouch = { ...(await cornerOf(c)), page: await pageState() };
  }
  await touch('touchEnd');
  await sleep(300);
  const after = await pageState();
  console.log('touch drag: before', JSON.stringify(before), 'mid', JSON.stringify(midTouch), 'after', JSON.stringify(after));
  check(midTouch.dragging, 'mid-drag (touch) the column is dragging');
  check(JSON.stringify(midTouch.page) === JSON.stringify(before) && JSON.stringify(after) === JSON.stringify(before), "the page doesn't scroll or slide its panes during the drag");
  await checkPlaced(c, 'bottom-left', 'phone dragged by touch', true);
  await shot(c, '05b-phone-bottom-left');
  await c.click('.voice-bar button[aria-label="Disconnect"], button[aria-label="Disconnect"]').catch(() => {});

  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await a.click('.voice-bar button[aria-label="Disconnect"]');

  // A DM call: Bob watches Alice's screen, opens the guild: the corner, "Go to the call".
  await openChat(b, alice.id);
  check((await cornerOf(b)).corner === (internet ? 'top-right' : 'bottom-right') && await b.evaluate(() => localStorage.getItem('pipCorner')) === (internet ? 'top-right' : 'bottom-right'), 'after a reload the corner is kept (localStorage pipCorner)');
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
  await checkPlaced(b, internet ? 'top-right' : 'bottom-right', "the call's stream in the kept corner");
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
