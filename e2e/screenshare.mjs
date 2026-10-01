// Screen sharing in a voice channel, through the e2e LiveKit (serve.mjs starts one): Alice and
// Bob are in a voice channel; Alice shares her screen (Chrome's fake screen) and sees her own
// stream; Bob sees her Live but downloads nothing until he clicks Watch Stream, then the video
// plays; Stop watching stops the download. Carol, on a phone, watches too. Bob shares, Alice
// (the owner) takes Video away from him and his stream ends; Alice stops hers.
//   node e2e/serve.mjs &   then   node e2e/screenshare.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

// Keeps every RTCPeerConnection the page makes (livekit-client is loaded on the first join,
// after this), so the test can read how much video it has received.
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

// Video bytes received over `ms`.
async function videoReceivedOver(page, ms) {
  const before = await videoBytesIn(page);
  await page.waitForTimeout(ms);
  return (await videoBytesIn(page)) - before;
}

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

const tile = (name) => `.voice-tile:has-text("${name}")`;
const sidebarMember = (name) => `.voice-member:has-text("${name}")`;
const live = (selector) => `${selector} .voice-live-badge`;

// Chrome's fake screen ("--use-fake-ui-for-media-stream" picks it without the picker).
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
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Stream Test');
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

  for (const page of [a, b]) {
    await recordPeerConnections(page);
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  console.log('alice and bob are in the channel');

  // Alice shares (the voice bar's button): she sees her own stream at once.
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await videoPlaying(a);
  console.log('alice is sharing and sees her own stream');
  await shot(a, '01-alice-sharing-own-preview');

  // Bob sees her Live (the LiveKit webhook told the API) but receives no video yet.
  await b.waitForSelector(live(sidebarMember(alice.name)), { timeout: 10000 });
  await b.waitForSelector(live(tile(alice.name)));
  const before = await videoReceivedOver(b, 3000);
  console.log('bob sees alice live; video received before watching:', before, 'bytes');
  if (before > 0) throw new Error('a stream nobody watches was downloaded');
  await shot(b, '02-bob-sees-alice-live');

  // Watch Stream: the video plays, and arrives.
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  const size = await b.$eval('.stream-view video', (v) => `${v.videoWidth}x${v.videoHeight}`);
  const watching = await videoReceivedOver(b, 3000);
  console.log(`bob watches alice's stream (${size}); received ${watching} bytes in 3 s`);
  if (watching < 10000) throw new Error('watching received too little video');
  await shot(b, '03-bob-watching');

  // Stop watching: the download stops.
  await b.click('.stream-view button[aria-label="Stop watching"]');
  await b.waitForSelector('.stream-view', { state: 'detached' });
  await b.waitForTimeout(1500);
  const after = await videoReceivedOver(b, 3000);
  console.log('after stop watching, received', after, 'bytes in 3 s');
  if (after > 0) throw new Error('still downloading after stop watching');

  // Carol, on a phone, opens the channel, joins and watches.
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.waitForSelector('.voice-view-join');
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  console.log('carol (phone) watches alice');
  await shot(c, '04-carol-phone-watching');

  // Bob shares too; then Alice takes Video away from him in this channel: his stream ends.
  await b.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector(live(tile(bob.name)), { timeout: 10000 });
  console.log('bob is sharing too');
  await a.evaluate(async ({ guildId, channelId, bobId }) => {
    const res = await fetch(`/api/guilds/${guildId}/channels/${channelId}/overrides/member/${bobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ allow: 0, deny: 1 << 19 }), // Video
    });
    if (!res.ok) throw new Error(`override: ${res.status}`);
  }, { guildId, channelId, bobId: bob.id });
  await a.waitForSelector(live(tile(bob.name)), { state: 'detached', timeout: 15000 });
  await b.waitForSelector('.voice-bar button[aria-label="Share your screen"]', { state: 'detached' });
  await b.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { state: 'detached' });
  console.log("Video taken from bob: his stream ended and his share button went");

  // Alice stops: Live goes for everyone, and Carol's stage closes.
  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await c.waitForSelector('.stream-view', { state: 'detached', timeout: 10000 });
  await b.waitForSelector(live(sidebarMember(alice.name)), { state: 'detached', timeout: 10000 });
  console.log('alice stopped: not live any more');
  await shot(c, '05-carol-after-stream-ended');
  console.log('OK');
} finally {
  await browser.close();
}
