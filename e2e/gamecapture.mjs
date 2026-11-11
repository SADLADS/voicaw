// Game capture's page side (Game capture in docs/desktop-and-site.md), through the e2e LiveKit:
// the sharer is the desktop app on Windows (a stand-in bridge: one game running, whose
// gameCapture hands over solid red frames drawn on a canvas, as the real app hands over the
// hooked game's textures). The picker opens on Games; Go Live shares the game's window (Chrome's
// fake screen here), then swaps the game's frames into the same stream: Bob, watching, sees red
// and a 1080p picture from a 2160p game (the chosen resolution kept). Then a game that can't be
// hooked: the window's share carries on, and the sharer is told why.
// What this can't check: the helper, OBS's hook and Electron's sharedTexture (Windows only).
//   node e2e/serve.mjs &   then   node e2e/gamecapture.mjs [screenshot dir]
import { launchChrome, signUp, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (!shots) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

// Runs in the sharer's page before the app: the desktop app's bridge on Windows. `hook` says
// how the next game capture goes: 'ok' (red frames, 3840x2160) or a failure code.
function fakeDesktop() {
  const thumb = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="384" height="216"><rect width="384" height="216" fill="darkred"/></svg>';
  let frameCallback = null;
  let stateCallback = null;
  let timer = null;
  window.__game = { hook: 'ok', starts: [], stops: 0 };
  const gameCapture = {
    start: async (hwnd, fps) => {
      window.__game.starts.push({ hwnd, fps });
      await new Promise((resolve) => setTimeout(resolve, 300)); // hooking takes a moment
      if (window.__game.hook !== 'ok') return { error: { code: window.__game.hook, message: 'stand-in failure' } };
      const canvas = new OffscreenCanvas(3840, 2160);
      const ctx = canvas.getContext('2d');
      let n = 0;
      timer = setInterval(() => {
        ctx.fillStyle = 'rgb(255, 0, 0)';
        ctx.fillRect(0, 0, 3840, 2160);
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect((n * 40) % 3800, 0, 40, 40); // something moving in a corner
        n++;
        const frame = new VideoFrame(canvas, { timestamp: performance.now() * 1000 });
        let given = false;
        // As the app's imported texture: one VideoFrame from it.
        const imported = { getVideoFrame: () => { given = true; return frame; } };
        Promise.resolve(frameCallback?.(imported)).finally(() => { if (!given) frame.close(); });
      }, 1000 / Math.min(fps, 30));
      setTimeout(() => stateCallback?.({ id: 7, state: 'live', width: 3840, height: 2160 }), 0);
      return { id: 7, width: 3840, height: 2160 };
    },
    stop: async () => {
      window.__game.stops++;
      clearInterval(timer);
    },
    setFrameRate: () => {},
    onState: (cb) => { stateCallback = cb; return () => { stateCallback = null; }; },
    onFrame: (cb) => { frameCallback = cb; return () => { frameCallback = null; }; },
  };
  const bridge = {
    platform: 'win32',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, autoUpdate: true, shortcuts: { toggleMute: null, toggleDeafen: null } }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    getScreenSources: async () => ({
      canShareSound: false,
      soundFrom: null,
      sources: [
        { id: 'screen:0:0', name: 'Entire screen', kind: 'screen', thumbnail: thumb, icon: null },
        { id: 'window:4242:0', name: 'Test Game', kind: 'window', thumbnail: thumb, icon: null },
      ],
      games: [{ hwnd: '4242', name: 'Test Game', sourceId: 'window:4242:0', thumbnail: thumb, icon: null }],
    }),
    chooseScreenSource: async () => true,
    getActivities: async () => [],
    getWindowState: async () => ({ maximized: false, fullScreen: false, focused: true }),
    spelling: { isMisspelled: () => false, suggestions: () => [] },
    gameCapture,
  };
  // Anything else the app asks for: listeners that never fire, calls that do nothing.
  window.voicawDesktop = new Proxy(bridge, {
    get: (target, key) => (key in target ? target[key]
      : typeof key === 'string' && key.startsWith('on') ? () => () => {} : () => Promise.resolve(null)),
  });
}

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

// The colour in the middle of the watched stream, and its size.
const streamPixel = (page) => page.$eval('.stream-view video', (v) => {
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(v, 0, 0);
  const [r, g, b] = ctx.getImageData(Math.floor(v.videoWidth / 2), Math.floor(v.videoHeight / 2), 1, 1).data;
  return { r, g, b, width: v.videoWidth, height: v.videoHeight };
});
const isRed = ({ r, g, b }) => r > 200 && g < 60 && b < 60;

const tile = (name) => `.voice-tile:has-text("${name}")`;

const browser = await launchChrome({
  args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen', '--screen-info={1920x1080}'],
});
try {
  const sharer = await signUp(browser, 'gamer');
  const bob = await signUp(browser, 'bob');
  const b = bob.page;

  // The sharer makes the guild and its voice channel in the browser, then opens the desktop app.
  const w = sharer.page;
  await w.click('button[aria-label="Add a guild"]');
  await w.fill('#new-guild-name', 'Game Night');
  await w.click('button:has-text("Create")');
  await w.waitForSelector('#dm-input');
  await w.click('.guild-header-button');
  await w.click('text=Create Channel');
  await w.click('label:has-text("Voice")');
  await w.fill('#channel-name', 'Lounge');
  await w.click('button:has-text("Create channel")');
  await w.waitForSelector('.voice-view-join');
  await w.click('.guild-header-button');
  await w.click('text=Invite People');
  await w.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await w.inputValue('#invite-link');
  await w.keyboard.press('Escape');
  const channel = w.url();
  await w.context().close();

  const appContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await appContext.addInitScript(fakeDesktop);
  const a = await appContext.newPage();
  a.on('pageerror', (e) => console.log('[sharer] page error:', e.message));
  // Refused requests (but admin alerts, which the app asks for and a non-admin is refused).
  a.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/admin/alerts')) console.log('[sharer]', r.status(), r.request().method(), r.url().replace(BASE, ''));
  });
  await a.goto(`${BASE}/`);
  await a.fill('input[placeholder="Username"]', sharer.name);
  await a.fill('input[placeholder="Password"]', sharer.password);
  await a.press('input[placeholder="Password"]', 'Enter');
  await a.waitForSelector('#dm-main', { timeout: 20000 });

  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');
  for (const page of [a, b]) {
    await page.goto(channel.replace(/^https?:\/\/[^/]+/, BASE));
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  console.log('the sharer (desktop app, Windows) and bob are in the channel');

  // The picker opens on Games, with the note; 1080p 30 fps chosen.
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.screen-picker .screen-picker-source:has-text("Test Game")');
  check(await a.getAttribute('.screen-picker [role="tab"]:has-text("Games")', 'aria-selected') === 'true', 'the picker did not open on Games');
  check(await a.locator('.screen-picker p:has-text("captured from inside")').count() === 1, 'no note on the Games tab');
  await a.click('.screen-picker .stream-quality-option:text-is("30 fps")');
  await a.click('.screen-picker .screen-picker-source:has-text("Test Game")');
  await shot(a, '01-picker-games');
  await a.click('.screen-picker button:has-text("Go Live")');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await a.waitForFunction(() => window.__game.starts.length === 1);
  const started = await a.evaluate(() => window.__game.starts[0]);
  check(started.hwnd === '4242' && started.fps === 30, `game capture started with ${JSON.stringify(started)}`);
  console.log('Go Live on the game: window shared, game capture started at 30 fps');

  // Bob watches: the game's red frames, at 1080p (2160p scaled to the chosen resolution).
  await b.waitForSelector(`${tile(sharer.name)} .voice-tile-watch`, { timeout: 15000 });
  await b.click(`${tile(sharer.name)} .voice-tile-watch`);
  await videoPlaying(b);
  await b.waitForFunction(() => {
    const v = document.querySelector('.stream-view video');
    if (!v?.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const [r, g, bl] = ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return r > 200 && g < 60 && bl < 60 && v.videoHeight <= 1080;
  }, null, { timeout: 25000 }).catch(() => {});
  const seen = await streamPixel(b);
  console.log('bob sees', JSON.stringify(seen));
  check(isRed(seen), 'bob does not see the game\'s frames');
  check(seen.height <= 1080 && seen.height >= 540, `the stream is ${seen.width}x${seen.height}, not at the chosen 1080p`);
  await shot(b, '02-bob-watching-game');
  await shot(a, '03-sharer-preview');
  const own = await a.evaluate(() => window.__game.stops);
  check(own === 0, 'the game capture stopped early');

  // Stopping the share stops the game capture.
  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await a.waitForFunction(() => window.__game.stops === 1, null, { timeout: 5000 });
  console.log('stopping the share stopped the game capture');

  // A game whose anti-cheat blocks the hook: the window share stays, with the reason.
  await a.evaluate(() => { window.__game.hook = 'hook_not_loaded'; });
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.screen-picker .screen-picker-source:has-text("Test Game")');
  await a.dblclick('.screen-picker .screen-picker-source:has-text("Test Game")');
  await a.waitForSelector('.voice-bar-message:has-text("anti-cheat")', { timeout: 10000 });
  check(await a.locator('.voice-bar button[aria-label="Stop sharing your screen"]').count() === 1, 'the window share ended with the game capture');
  await b.waitForSelector(`${tile(sharer.name)} .voice-tile-watch, .stream-view video`, { timeout: 15000 });
  await shot(a, '04-hook-blocked-window-shared');
  console.log('a blocked hook: still sharing the window, and the sharer is told why');
  console.log('OK');
} finally {
  await browser.close();
}
