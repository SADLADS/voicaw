// Focusing a camera, through the e2e LiveKit (Chrome's fake camera): cameras fill the page with
// everyone else small under them; a click makes one big like a watched stream (uncropped, a
// sharper layer, its person's picture in the row), a right click sets the volume (the stage's
// slider is the same one), Escape, ✕, a click on them again or the arrows move on; a double click
// is full screen; your own can be focused (mirrored, no volume). A stream being watched shrinks
// into the row still playing, and comes back on a click. On another page it's in the corner,
// and it pops out into a window, which keeps downloading while the page is hidden. Their camera
// going off ends the focus. A phone taps and holds, and sees a paused camera's picture. A DM call
// does the same.
//   node e2e/serve.mjs &   then   node e2e/camerafocus.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, fakeMicArgs, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const recordPeerConnections = (page) => page.evaluate(() => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function RTCPeerConnection(...args) {
    const pc = new Original(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
});

const videoBytesIn = (page) => page.evaluate(async () => {
  let total = 0;
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') total += s.bytesReceived;
    });
  }
  return total;
});

async function videoReceivedOver(page, ms) {
  const before = await videoBytesIn(page);
  await page.waitForTimeout(ms);
  return (await videoBytesIn(page)) - before;
}

async function playing(page, selector) {
  const video = await page.locator(selector).first().elementHandle({ timeout: 20000 });
  await page.waitForFunction((v) => v.isConnected && v.videoWidth > 0 && !v.paused && v.currentTime > 0.2, video, { timeout: 20000 }).catch(async (err) => {
    const state = await video.evaluate((v) => ({ connected: v.isConnected, width: v.videoWidth, paused: v.paused, time: v.currentTime, stream: Boolean(v.srcObject), tracks: v.srcObject?.getTracks().map((t) => `${t.kind} ${t.readyState} muted=${t.muted}`) }));
    throw new Error(`FAILED: ${selector} never played: ${JSON.stringify(state)}: ${err.message}`);
  });
  const t = await video.evaluate((v) => v.currentTime);
  await page.waitForTimeout(800);
  const later = await video.evaluate((v) => v.currentTime);
  if (!(later > t)) throw new Error(`FAILED: ${selector} stopped (${t} → ${later})`);
}

const size = (page, selector) => page.locator(selector).first().evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, boxW: v.clientWidth, boxH: v.clientHeight, fit: getComputedStyle(v).objectFit, transform: getComputedStyle(v).transform }));
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const tile = (name) => `.voice-tile:has-text("${name}")`;
const offCentre = { position: { x: 12, y: 12 } };
const STAGE = '.stream-view:not(.corner)';
const CAMERA_STAGE = '.stream-view.camera:not(.corner)';
const SCREEN_STAGE = '.stream-view:not(.camera):not(.corner)';

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('pageerror', (err) => console.log(`[${who} pageerror]`, err.message));
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Focus Test');
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
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  await recordPeerConnections(a);
  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await a.waitForSelector(tile(carol.name));

  // Everyone's picture, until a camera comes on. Then cameras fill the page.
  check(await a.locator('.voice-view-cameras').count() === 0, 'no cameras: the usual tiles');
  await b.click('.voice-view-controls button[aria-label="Turn on camera"]');
  await a.click('.voice-view-controls button[aria-label="Turn on camera"]');
  const bobsCamera = `video[aria-label="${bob.name}'s camera"]`;
  const ownCamera = 'video[aria-label="Your camera"]';
  await playing(a, `.voice-view-cameras ${bobsCamera}`);
  await playing(a, `.voice-view-cameras ${ownCamera}`);
  const grid = await a.evaluate(() => {
    const box = document.querySelector('.voice-view-cameras');
    const tiles = [...box.querySelectorAll('.voice-tile')].map((el) => el.getBoundingClientRect());
    return { scrolls: box.scrollHeight > box.clientHeight, boxW: box.clientWidth, widths: tiles.map((r) => r.width), lefts: tiles.map((r) => r.left), tops: tiles.map((r) => r.top) };
  });
  check(grid.widths.length === 2 && grid.widths[0] > grid.boxW * 0.4, `two cameras fill the page (${Math.round(grid.widths[0])}px of ${grid.boxW}px)`);
  check(!grid.scrolls, 'and it doesn\'t scroll');
  check(await a.locator(`.voice-view-others ${tile(carol.name)}`).count() === 1, 'someone without a camera is small under them');
  const smallHeight = await a.locator(`.voice-view-others ${tile(carol.name)}`).evaluate((el) => el.getBoundingClientRect().height);
  check(smallHeight < 60, `small tile is ${Math.round(smallHeight)}px tall`);
  await shot(a, '01-cameras-fill');
  await a.waitForTimeout(3000); // the layer settles
  const inGrid = await size(a, `.voice-view-cameras ${bobsCamera}`);
  await a.click('.voice-view-controls button[aria-label="Turn off camera"]');
  await a.waitForSelector(`.voice-view-cameras ${ownCamera}`, { state: 'detached', timeout: 10000 });
  const alone = await a.locator(`.voice-view-cameras ${tile(bob.name)}`).evaluate((el) => el.getBoundingClientRect().width);
  check(alone > grid.widths[0], `one camera gets bigger (${Math.round(alone)}px)`);
  await a.click('.voice-view-controls button[aria-label="Turn on camera"]');
  await playing(a, `.voice-view-cameras ${ownCamera}`);

  // A click focuses, uncropped, no volume menu; their picture stays in the row, one video.
  await a.click(tile(bob.name));
  await a.waitForSelector(CAMERA_STAGE);
  await playing(a, `${CAMERA_STAGE} ${bobsCamera}`);
  check(await a.locator('.user-volume-head').count() === 0, 'a click doesn\'t open the volume');
  check(await a.locator(bobsCamera).count() === 1, 'only the stage draws the focused camera');
  check(await a.locator('.voice-view.watching').count() === 1, 'the people become a row');
  check(await a.locator(`${tile(bob.name)}.on-stage .voice-tile-avatar`).count() === 1, 'their picture marks them in the row');
  const focused = await size(a, `${CAMERA_STAGE} ${bobsCamera}`);
  check(focused.fit === 'contain', 'uncropped');
  check(await a.locator(`${CAMERA_STAGE} .voice-live-badge`).count() === 0, 'no Live badge');
  check(await a.locator(`${CAMERA_STAGE} .stream-zoom-slider`).count() === 0, 'no zoom slider');
  await shot(a, '02-focused');
  await a.waitForTimeout(3000);
  const sharper = await size(a, `${CAMERA_STAGE} ${bobsCamera}`);
  console.log(`bob's camera: ${inGrid.w}x${inGrid.h} in the grid (${inGrid.boxW}px), ${sharper.w}x${sharper.h} focused (${sharper.boxW}px)`);
  check(sharper.w >= inGrid.w, 'a focused camera isn\'t a smaller copy');

  // Wheel zooms a camera too.
  await a.hover(`${CAMERA_STAGE} video`);
  await a.mouse.wheel(0, -300);
  await a.waitForSelector(`${CAMERA_STAGE}.zoomed`);
  check(await a.locator(`${CAMERA_STAGE} .stream-zoom-reset`).count() === 1, 'the wheel zooms, with the percentage to fit it again');
  await a.click(`${CAMERA_STAGE} .stream-zoom-reset`);
  await a.waitForSelector(`${CAMERA_STAGE}.zoomed`, { state: 'detached' });

  // Volume: right click in the row, the same as the stage's slider. Escape closes only the menu.
  const stageVolume = `${CAMERA_STAGE} input[aria-label="Volume (just for you)"]`;
  await a.hover(`${CAMERA_STAGE} .stream-volume`);
  await a.locator(stageVolume).fill('60');
  await a.click(tile(bob.name), { button: 'right' });
  await a.waitForSelector('.user-volume-head');
  const inMenu = await a.locator('.user-volume-value').textContent();
  check(inMenu === '60%', `the stage's slider is the person's volume (menu says ${inMenu})`);
  await a.keyboard.press('Escape');
  await a.waitForSelector('.user-volume-head', { state: 'detached' });
  check(await a.locator(CAMERA_STAGE).count() === 1, 'Escape closed only the menu');
  await a.hover(`${CAMERA_STAGE} .stream-volume`);
  await a.locator(stageVolume).fill('100');

  // Ways back: Escape, a click on them in the row, ✕.
  await a.keyboard.press('Escape');
  await a.waitForSelector(STAGE, { state: 'detached' });
  await a.waitForSelector('.voice-view-cameras');
  console.log('ok: Escape goes back to everyone');
  await a.click(tile(bob.name));
  await a.waitForSelector(CAMERA_STAGE);
  await a.click(tile(bob.name));
  await a.waitForSelector(STAGE, { state: 'detached' });
  console.log('ok: a click on them goes back');
  await a.click(tile(bob.name));
  await a.click(`${CAMERA_STAGE} button[aria-label="Back to everyone"]`);
  await a.waitForSelector(STAGE, { state: 'detached' });
  console.log('ok: ✕ goes back');

  // Arrows step through the cameras.
  await a.click(tile(bob.name));
  await a.waitForSelector(`${CAMERA_STAGE} ${bobsCamera}`);
  await a.keyboard.press('ArrowLeft');
  await a.waitForSelector(`${CAMERA_STAGE} ${ownCamera}`);
  // Your own: mirrored, no volume or quality, right click does nothing.
  const own = await size(a, `${CAMERA_STAGE} ${ownCamera}`);
  check(own.transform.startsWith('matrix(-1'), 'your own is mirrored on the stage');
  check(await a.locator(`${CAMERA_STAGE} .stream-volume`).count() === 0, 'and has no volume');
  await a.keyboard.press('ArrowRight');
  await a.waitForSelector(`${CAMERA_STAGE} ${bobsCamera}`);
  console.log('ok: arrows step through the cameras');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.voice-view-cameras');

  // A double click: focused and full screen; back; not unfocused by its second click.
  await a.dblclick(`.voice-view-cameras ${tile(bob.name)}`);
  await a.waitForFunction(() => document.fullscreenElement?.matches('.stream-view.camera'));
  check(await a.locator('.user-volume-head').count() === 0, 'double click: full screen, no menu');
  await shot(a, '03-full-screen');
  await a.evaluate(() => document.exitFullscreen());
  await a.waitForFunction(() => !document.fullscreenElement);
  check(await a.locator(CAMERA_STAGE).count() === 1, 'still focused after leaving full screen');
  // From the row: the second click doesn't take the focus away.
  await a.dblclick(tile(alice.name));
  await a.waitForFunction(() => document.fullscreenElement?.querySelector('video[aria-label="Your camera"]'));
  await a.evaluate(() => document.exitFullscreen());
  await a.waitForFunction(() => !document.fullscreenElement);
  check(await a.locator(`${CAMERA_STAGE} ${ownCamera}`).count() === 1, 'a double click in the row focuses and goes full screen');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.voice-view-cameras');

  // A watched stream shrinks into the row, still playing, and comes back on a click.
  await b.click('.voice-view-controls button[aria-label="Share your screen"]');
  await b.click('.go-live-dialog button:has-text("Go Live")');
  await a.click(`${tile(bob.name)} .voice-tile-watch`);
  await a.waitForSelector(SCREEN_STAGE);
  await playing(a, `${SCREEN_STAGE} video`);
  check(await a.locator('.stream-tile').count() === 0, 'a stream on the stage has no small tile');
  await a.click(tile(bob.name));
  await a.waitForSelector(`${CAMERA_STAGE} ${bobsCamera}`);
  const small = `.stream-tile video[aria-label="${bob.name}'s screen"]`;
  await playing(a, small);
  check(await a.locator(`${tile(bob.name)} .voice-tile-watch`).count() === 0, 'no Watch Stream for the one playing small');
  await shot(a, '04-stream-in-the-row');
  // Pictures of it in every theme, with Carol small (the row and the grid).
  const themes = ['light', 'familiar', 'halloween', 'christmas', 'slack'];
  const inTheme = (theme) => a.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  const dark = await a.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of shots ? themes : []) {
    await inTheme(theme);
    await shot(a, `theme-${theme}-row`);
  }
  await inTheme(dark);
  await a.click('.stream-tile');
  await a.waitForSelector(SCREEN_STAGE);
  await playing(a, `${SCREEN_STAGE} video`);
  check(await a.locator('.stream-tile').count() === 0, 'a click brings it back to the stage');
  await a.click(tile(bob.name));
  await a.waitForSelector('.stream-tile');
  await a.hover('.stream-tile');
  await a.click('.stream-tile-stop');
  await a.waitForSelector('.stream-tile', { state: 'detached' });
  check(await a.locator(`${CAMERA_STAGE} ${bobsCamera}`).count() === 1, 'stopping the small one leaves the camera');
  await a.click(`${tile(bob.name)} .voice-tile-watch`);
  await a.waitForSelector(SCREEN_STAGE);
  await a.click(tile(bob.name));
  await a.waitForSelector('.stream-tile');

  // The corner takes what was big; the stream stays the page's.
  await a.click('.guild-channel-link:has-text("general")');
  await a.waitForSelector('#dm-input');
  await a.waitForSelector('.stream-view.corner.camera');
  await playing(a, `.stream-view.corner.camera ${bobsCamera}`);
  check(await a.locator('.stream-view.corner').count() === 1, 'a focused camera carries on in the corner');
  await shot(a, '05-corner');
  await a.click('.stream-view.corner button[aria-label="Go to the voice channel"]');
  await a.waitForSelector(CAMERA_STAGE);
  check(await a.locator('.stream-view.corner').count() === 0, 'and back on the page');
  await a.click('.stream-tile-stop', { force: true });
  await a.waitForSelector('.stream-tile', { state: 'detached' });
  await a.click('.guild-channel-link:has-text("general")');
  await a.click('.stream-view.corner button[aria-label="Close"]');
  await a.waitForSelector('.stream-view.corner', { state: 'detached' });
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-view-cameras');
  console.log('ok: the corner\'s ✕ ends the focus');

  // Pop out: its own window, kept downloading while the page is hidden. (Bob is still sharing:
  // the middle of his tile is Watch Stream.)
  await a.click(tile(bob.name), offCentre);
  await a.waitForSelector(CAMERA_STAGE);
  const [popup] = await Promise.all([a.context().waitForEvent('page'), a.click(`${CAMERA_STAGE} button[aria-label="Pop out"]`)]);
  await popup.waitForSelector(`.stream-view.camera.popped-out ${bobsCamera}`);
  await playing(popup, bobsCamera);
  check((await popup.title()).includes(`${bob.name}'s camera`), 'the window has its title');
  await a.waitForSelector('.stream-popped-note:has-text("is in its own window")');
  check(await a.locator(STAGE).count() === 0, 'the page shows a note');
  await shot(a, '06-popped-out-note');
  await shot(popup, '07-popped-out');
  const setHidden = (hidden) => a.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  await a.waitForTimeout(1500);
  const whileHidden = await videoReceivedOver(a, 2000);
  check(whileHidden > 3000, `a popped-out camera keeps coming while the page is hidden (${whileHidden} bytes in 2 s)`);
  await setHidden(false);
  // Swapping from the page changes the window.
  await a.keyboard.press('ArrowLeft');
  await popup.waitForSelector('video[aria-label="Your camera"]');
  await a.keyboard.press('ArrowRight');
  await popup.waitForSelector(bobsCamera);
  await a.click('.stream-popped-note button:has-text("Bring back")');
  await a.waitForSelector(CAMERA_STAGE);
  console.log('ok: Bring back returns it to the page');
  const [popup2] = await Promise.all([a.context().waitForEvent('page'), a.click(`${CAMERA_STAGE} button[aria-label="Pop out"]`)]);
  await popup2.waitForSelector(bobsCamera);
  await Promise.all([popup2.waitForEvent('close'), popup2.click('button[aria-label="Close"]', { noWaitAfter: true })]);
  await a.waitForSelector('.voice-view-cameras');
  console.log('ok: its ✕ ends the focus and closes the window');

  // Data saver: at most 360p, named Video quality here.
  await a.click(tile(bob.name), offCentre);
  await a.waitForSelector(CAMERA_STAGE);
  await a.click(`${CAMERA_STAGE} button[aria-label="Video quality"]`);
  await a.click('.stream-view-quality-item:has-text("Data saver")');
  await a.waitForTimeout(4000);
  const saving = await size(a, `${CAMERA_STAGE} ${bobsCamera}`);
  console.log(`data saver: ${saving.w}x${saving.h} in ${saving.boxW}px`);
  check(saving.h <= 360, 'Data saver keeps a camera at 360p or less');
  await a.click(`${CAMERA_STAGE} button[aria-label="Video quality"]`);
  await a.click('.stream-view-quality-item:has-text("Auto")');

  // Their camera going off ends the focus.
  await b.click('.voice-view-controls button[aria-label="Turn off camera"]');
  await a.waitForSelector(STAGE, { state: 'detached', timeout: 10000 });
  console.log('ok: the camera going off ends the focus');
  await b.click('.voice-view-controls .screen-share-toggle');
  await a.waitForSelector(`${tile(bob.name)} .voice-live-badge`, { state: 'detached', timeout: 10000 });
  await b.click('.voice-view-controls button[aria-label="Turn on camera"]');
  await a.waitForSelector(`.voice-view-cameras ${bobsCamera}`);

  // Carol, on a phone: a tap focuses, a hold opens the volume sheet; it fits.
  await playing(c, `.voice-view-cameras ${bobsCamera}`);
  await shot(c, '08-phone-grid');
  check(await noSidewaysScroll(c), 'the phone\'s grid fits');
  await c.tap(tile(bob.name));
  await c.waitForSelector(CAMERA_STAGE);
  await playing(c, `${CAMERA_STAGE} ${bobsCamera}`);
  check(await c.locator('.user-volume-head').count() === 0, 'a tap focuses, without the volume');
  check(await noSidewaysScroll(c), 'the phone\'s stage fits');
  await shot(c, '09-phone-focused');
  await c.tap(`${CAMERA_STAGE} button[aria-label="Back to everyone"]`);
  await c.waitForSelector(STAGE, { state: 'detached' });
  const box = await c.locator(tile(bob.name)).boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await c.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // The finger lifting from the hold doesn't count as a tap on the sheet's backdrop.
  await c.waitForTimeout(300);
  await c.waitForSelector('.user-volume-head');
  check(await c.locator(STAGE).count() === 0, 'a hold opens the volume, without focusing');
  await shot(c, '10-phone-volume');
  await c.keyboard.press('Escape');
  await c.waitForSelector('.user-volume-head', { state: 'detached' });

  // Alice focuses Carol's camera; it pauses with her page hidden: her picture, then it's back.
  await c.click('.voice-view-controls button[aria-label="Turn on camera"]');
  const carolsCamera = `video[aria-label="${carol.name}'s camera"]`;
  await playing(a, `.voice-view-cameras ${carolsCamera}`);
  await a.click(tile(carol.name));
  await a.waitForSelector(`${CAMERA_STAGE} ${carolsCamera}`);
  await playing(a, `${CAMERA_STAGE} ${carolsCamera}`);
  await c.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await a.waitForSelector(`${CAMERA_STAGE} .stream-camera-waiting:has-text("Camera paused")`, { timeout: 10000 });
  check(await a.locator(CAMERA_STAGE).count() === 1, 'a paused camera stays focused, with its picture');
  await shot(a, '11-paused');
  await c.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await a.waitForSelector(`${CAMERA_STAGE} .stream-camera-waiting`, { state: 'detached', timeout: 15000 });
  await playing(a, `${CAMERA_STAGE} ${carolsCamera}`);
  console.log('ok: back from paused, it plays on the stage');
  // Leaving ends it.
  await c.click('.voice-view-controls button[aria-label="Disconnect"]');
  await a.waitForSelector(STAGE, { state: 'detached', timeout: 15000 });
  console.log('ok: their leaving ends the focus');
  for (const page of [a, b]) await page.click('.voice-view-controls button[aria-label="Disconnect"]');

  // A DM call: the same, in the call's panel, on Light too.
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await b.waitForSelector('.call-panel .voice-view-controls');
  await a.click('.call-panel button[aria-label="Turn on camera"]');
  await b.click('.call-panel button[aria-label="Turn on camera"]');
  await playing(a, `.call-panel-person ${bobsCamera}`);
  const person = `.call-panel-person:has(${bobsCamera})`;
  await a.click(person);
  await a.waitForSelector(`.call-panel ${CAMERA_STAGE} ${bobsCamera}`);
  await playing(a, `.call-panel ${CAMERA_STAGE} ${bobsCamera}`);
  check(await a.locator(bobsCamera).count() === 1, 'call: the stage draws it once');
  const panelInView = await a.evaluate(() => document.querySelector('.call-panel .stream-view').getBoundingClientRect().height <= innerHeight * 0.45);
  check(panelInView, 'call: the chat keeps its room');
  await shot(a, '12-dm-call-focused');
  await a.click(`.call-panel-person[title="Back to everyone"]`, { button: 'right' });
  await a.waitForSelector('.user-volume-head');
  await a.keyboard.press('Escape');
  await a.keyboard.press('Escape');
  await a.waitForSelector(`.call-panel ${STAGE}`, { state: 'detached' });
  console.log('ok: DM call: focus, right click for the volume, Escape');
  await a.dblclick(person);
  await a.waitForFunction(() => document.fullscreenElement?.matches('.stream-view.camera'));
  await a.evaluate(() => document.exitFullscreen());
  await a.waitForFunction(() => !document.fullscreenElement);
  console.log('ok: DM call: double click is full screen');
  await a.click('.call-panel button[aria-label="Hang up"]');
  await b.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });
  console.log('OK');
} finally {
  await browser.close();
}
