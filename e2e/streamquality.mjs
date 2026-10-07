// Screen share quality, through the e2e LiveKit (serve.mjs starts one): an admin shares at
// 720p 30 fps from the Go Live dialog (what Chrome is asked for, what the encoder is told,
// LiveKit's half-size simulcast copy, what Bob receives), sets Settings → Admin's limits to
// 720p 15 fps, rejoins: the dialog greys out the rest and the stream goes out at 15 fps.
// Settings → Voice & video's Screen share section, the admin menus, a phone-width Settings.
//   node e2e/serve.mjs &   then   node e2e/streamquality.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

// Keeps every RTCPeerConnection the page makes, and what getDisplayMedia is asked for.
const record = (page) => page.evaluate(() => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function RTCPeerConnection(...args) {
    const pc = new Original(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = (options) => {
    window.__displayMediaOptions = options;
    return original(options);
  };
});

// The screen share's sender: its encodings (simulcast layers) and the captured track's size.
const screenSender = (page) => page.evaluate(() => {
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue;
    for (const sender of pc.getSenders()) {
      const track = sender.track;
      if (!track || track.kind !== 'video' || track.readyState !== 'live') continue;
      const { width, height, frameRate } = track.getSettings();
      return {
        encodings: sender.getParameters().encodings.map((e) => ({
          maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, scale: e.scaleResolutionDownBy ?? 1,
        })),
        width, height, frameRate, contentHint: track.contentHint,
      };
    }
  }
  return null;
});

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

const radio = (name) => `.go-live-dialog .stream-quality-option:text-is("${name}")`;
const tile = (name) => `.voice-tile:has-text("${name}")`;

async function setLimit(page, key, value) {
  await page.evaluate(async ({ key, value }) => {
    const res = await fetch(`/api/admin/settings/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(`${key}: ${res.status}`);
  }, { key, value });
}

// A 1920x1080 screen for Chrome's fake capture (picked without the picker).
const browser = await launchChrome({
  args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen', '--screen-info={1920x1080}'],
});
try {
  const admin = await signUp(browser, 'admin');
  const bob = await signUp(browser, 'bob');
  const a = admin.page;
  const b = bob.page;
  for (const [who, page] of [['admin', a], ['bob', b]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Quality Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);

  for (const page of [a, b]) {
    await record(page);
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  console.log('admin and bob are in the channel');

  // Share: the dialog first, at the default (1080p, 15 fps), nothing greyed out.
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.go-live-dialog');
  check(await a.getAttribute(radio('1080p'), 'aria-checked') === 'true', '1080p is not the default');
  check(await a.getAttribute(radio('15 fps'), 'aria-checked') === 'true', '15 fps is not the default');
  check(await a.locator('.go-live-dialog .stream-quality-option:disabled').count() === 0, 'something is greyed out without a limit');
  await a.click(radio('720p'));
  await a.click(radio('30 fps'));
  await shot(a, '01-go-live-dialog');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await videoPlaying(a);
  const asked = await a.evaluate(() => window.__displayMediaOptions?.video);
  console.log('Chrome asked for', JSON.stringify(asked));
  check(asked?.height?.max === 720 && asked?.width?.max === 1280 && asked?.frameRate?.max === 30, 'not asked for 720p at 30 fps');
  const sending = await screenSender(a);
  console.log('sending', JSON.stringify(sending));
  check(sending.height <= 720, `captured at ${sending.height}p`);
  check(sending.contentHint === 'motion', 'not hinted as motion');
  const full = sending.encodings.find((e) => e.scale === 1);
  check(full?.maxBitrate === 2_500_000 && full?.maxFramerate === 30, 'the encoder was not told 2.5 Mbps at 30 fps');
  check(sending.encodings.length === 2 && sending.encodings.some((e) => e.scale === 2), 'no half-size simulcast copy');

  await b.click(`${tile(admin.name)} .voice-tile-watch`);
  await videoPlaying(b);
  const seen = await b.$eval('.stream-view video', (v) => ({ width: v.videoWidth, height: v.videoHeight }));
  console.log(`bob receives ${seen.width}x${seen.height}`);
  check(seen.height <= 720 && seen.height >= 360, 'bob does not get the 720p stream');
  await shot(b, '02-bob-watching');
  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await a.waitForSelector('.voice-bar button[aria-label="Share your screen"]');

  // The admin limits streams to 720p at 15 fps (from the next join).
  await setLimit(a, 'streamMaxResolution', '720');
  await setLimit(a, 'streamMaxFramerate', '15');
  await a.click('.voice-bar button[aria-label="Disconnect"]');
  await a.waitForSelector('.voice-bar', { state: 'detached' });
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.go-live-dialog');
  for (const name of ['1080p', 'Source', '30 fps', '60 fps']) {
    check(await a.locator(radio(name)).isDisabled(), `${name} is not greyed out`);
  }
  check(await a.getAttribute(radio('15 fps'), 'aria-checked') === 'true', 'the limit is not what shows as chosen');
  await a.waitForSelector('.go-live-dialog >> text=This server allows streams up to 720p at 15 fps.');
  await shot(a, '03-go-live-limited');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  const limited = await screenSender(a);
  console.log('limited, sending', JSON.stringify(limited));
  const limitedFull = limited.encodings.find((e) => e.scale === 1);
  check(limitedFull?.maxBitrate === 1_500_000 && limitedFull?.maxFramerate === 15, 'the limit did not reach the encoder');
  check(limited.contentHint === 'detail', 'not hinted as detail at 15 fps');
  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');

  // Settings: the section in Voice & video (still the device's own choice, 720p 30 fps), and
  // the admin's menus.
  await a.goto(`${BASE}/settings#voice-video`);
  await a.waitForSelector('.stream-quality');
  check(await a.getAttribute('.stream-quality-option:text-is("30 fps")', 'aria-checked') === 'true', 'Settings lost the choice');
  await a.locator('.stream-quality').scrollIntoViewIfNeeded();
  await shot(a, '04-settings-voice');
  const menu = await a.waitForSelector('#admin-streamMaxResolution');
  check(await menu.inputValue() === '720', 'the admin menu does not show 720p');
  await menu.scrollIntoViewIfNeeded();
  await shot(a, '05-settings-admin');
  await setLimit(a, 'streamMaxResolution', null);
  await setLimit(a, 'streamMaxFramerate', null);

  // Settings at phone width: the section fits.
  const { page: p } = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await p.goto(`${BASE}/settings#voice-video`);
  const fits = await p.waitForSelector('.stream-quality').then(() => p.evaluate(() => {
    const box = document.querySelector('.stream-quality').getBoundingClientRect();
    return box.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
  }));
  await p.locator('.stream-quality').scrollIntoViewIfNeeded();
  await shot(p, '06-phone-settings');
  check(fits, 'the section is wider than the phone');
  console.log('OK');
} finally {
  await browser.close();
}
