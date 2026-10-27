// Cameras, through the e2e LiveKit (Chrome's fake camera): in a voice channel Alice turns hers
// on and sees herself (mirrored); Bob's tile for her plays it, at a small simulcast layer; the
// channel list marks it; Bob downloads nothing while he's on another page; Carol, on a phone,
// sees it too. Bob turns his on and Alice (the owner) takes Video away: it goes off. Alice
// turns hers off. Then a DM call with both cameras (LiveKit only sees encrypted video, and each
// side's video decodes, so it decrypted), and a group call, where Carol's phone switches between
// its front and back camera.
//   node e2e/serve.mjs &   then   node e2e/camera.mjs [screenshot dir]
// (E2E_API_PORT too when serve.mjs isn't on the default ports: it reads LiveKit's keys.)
import { readFileSync } from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { launchChrome, signUp, openChat, devices, fakeMicArgs, livekitInfoPath, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const livekit = JSON.parse(readFileSync(livekitInfoPath(), 'utf8'));
const roomService = new RoomServiceClient(livekit.url, livekit.key, livekit.secret);

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

// A camera <video> under `selector` that's playing (frames decoded: with the wrong key there
// are none).
const cameraVideo = (page, selector) => page.locator(`${selector} video.camera-video`).first();

async function cameraPlaying(page, selector) {
  const video = await cameraVideo(page, selector).elementHandle({ timeout: 20000 });
  await page.waitForFunction((v) => v.isConnected && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3, video, { timeout: 20000 });
}

const videoSize = (page, selector) => cameraVideo(page, selector).evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, tile: v.clientWidth }));

const tile = (name) => `.voice-tile:has-text("${name}")`;
const sidebarMember = (name) => `.voice-member:has-text("${name}")`;
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
}, { method, path, body });

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  // Groups are made from friends.
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated|abort/i.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
    page.on('pageerror', (err) => console.log(`[${who} pageerror]`, err.message));
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Camera Test');
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

  // Alice turns her camera on from the channel page: she sees herself, mirrored.
  await a.click('.voice-view-controls button[aria-label="Turn on camera"]');
  await a.waitForSelector('.voice-view-controls button[aria-label="Turn off camera"]', { timeout: 10000 });
  await cameraPlaying(a, tile(alice.name));
  const mirrored = await cameraVideo(a, tile(alice.name)).evaluate((v) => getComputedStyle(v).transform);
  if (!mirrored.startsWith('matrix(-1')) throw new Error(`own camera not mirrored: ${mirrored}`);
  console.log('alice sees her own camera, mirrored');
  await shot(a, '01-alice-own-camera');

  // Bob: the tile plays it, a small layer for a small tile; the channel list marks it.
  await cameraPlaying(b, tile(alice.name));
  await b.waitForSelector(`${sidebarMember(alice.name)} [aria-label="Camera on"]`, { timeout: 10000 });
  await b.waitForTimeout(3000); // the layer settles
  const small = await videoSize(b, tile(alice.name));
  const sent = await videoSize(a, tile(alice.name));
  console.log(`bob sees alice's camera at ${small.w}x${small.h} in a ${small.tile}px tile (she sends ${sent.w}x${sent.h})`);
  if (sent.w > 0 && small.w >= sent.w && sent.w > 640) throw new Error('a small tile got the full-size layer');
  const watching = await videoReceivedOver(b, 2000);
  if (watching < 5000) throw new Error(`bob received too little video: ${watching}`);
  await shot(b, '02-bob-sees-alice-camera');

  // Bob goes to another page: the camera isn't downloaded there; back, it plays again.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector('#dm-input');
  await b.waitForTimeout(1500);
  const away = await videoReceivedOver(b, 3000);
  console.log('bob on a text channel received', away, 'bytes of video in 3 s');
  if (away > 0) throw new Error('a camera nobody shows was downloaded');
  await b.click('.guild-channel-link:has-text("lounge")');
  await cameraPlaying(b, tile(alice.name));
  console.log('back on the channel, it plays again');

  // Carol, on a phone: joins and sees it.
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.waitForSelector(`${tile(alice.name)} [aria-label="Camera on"]`);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await cameraPlaying(c, tile(alice.name));
  console.log('carol (phone) sees alice\'s camera');
  await shot(c, '03-carol-phone');

  // Bob turns his on (the voice bar's button); Alice takes Video away from him: it goes off.
  await b.click('.voice-bar button[aria-label="Turn on camera"]');
  await cameraPlaying(a, tile(bob.name));
  console.log('bob\'s camera is on');
  await shot(a, '04-both-cameras');
  await api(a, 'PUT', `/guilds/${guildId}/channels/${channelId}/overrides/member/${bob.id}`, { allow: 0, deny: 1 << 19 });
  await a.waitForSelector(`${tile(bob.name)} video`, { state: 'detached', timeout: 15000 });
  await b.waitForSelector('.voice-bar button[aria-label="Turn off camera"]', { state: 'detached' });
  await b.waitForSelector('.voice-bar button[aria-label="Turn on camera"]', { state: 'detached' });
  console.log('Video taken from bob: his camera went off and his button went');

  // Alice turns hers off: tiles go back to pictures, the mark goes.
  await a.click('.voice-bar button[aria-label="Turn off camera"]');
  await c.waitForSelector(`${tile(alice.name)} video`, { state: 'detached', timeout: 10000 });
  await b.waitForSelector(`${sidebarMember(alice.name)} [aria-label="Camera on"]`, { state: 'detached', timeout: 10000 });
  console.log('alice turned hers off');
  await shot(c, '05-carol-after');
  for (const page of [a, b, c]) await page.click('.voice-view-controls button[aria-label="Disconnect"]');

  // A DM call with both cameras.
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await b.waitForSelector('.call-panel .voice-view-controls');
  await a.click('.call-panel button[aria-label="Turn on camera"]');
  await b.click('.call-panel button[aria-label="Turn on camera"]');
  await cameraPlaying(b, `.call-panel-person:has([aria-label="${alice.name}'s camera"])`);
  await cameraPlaying(a, `.call-panel-person:has([aria-label="${bob.name}'s camera"])`);
  const call = await a.evaluate(async () => {
    const res = await fetch('/api/dm-calls/current', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return res.json();
  });
  const participants = await roomService.listParticipants(`call-${call.id}`);
  const tracks = participants.flatMap((p) => p.tracks.map((t) => ({ who: p.identity, source: t.source, encryption: t.encryption })));
  console.log('call tracks in LiveKit:', JSON.stringify(tracks));
  const cameras = tracks.filter((t) => t.source === 1); // TrackSource.CAMERA
  if (cameras.length !== 2 || cameras.some((t) => !t.encryption)) throw new Error('call video is not end-to-end encrypted');
  console.log('DM call: both cameras play, encrypted end to end');
  await shot(a, '06-dm-call-cameras');
  await b.click('.call-panel button[aria-label="Hang up"]');
  await a.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });

  // A group call: Alice's camera shows in the group's panel for Carol (phone).
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Cams');
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await a.click('button[aria-label="Start a group call"]');
  await c.waitForSelector('.incoming-call', { timeout: 15000 });
  await c.click('.incoming-call button[aria-label="Accept"]');
  await c.waitForSelector('.group-call-panel .voice-view-controls', { timeout: 20000 });
  await a.waitForSelector('.group-call-panel button[aria-label="Turn on camera"]', { timeout: 20000 });
  await a.click('.group-call-panel button[aria-label="Turn on camera"]');
  await cameraPlaying(c, '.group-call-panel');
  await cameraPlaying(a, '.group-call-panel');
  console.log('group call: carol (phone) sees alice\'s camera');
  await c.waitForTimeout(500);
  await shot(c, '07-group-call-phone');
  await shot(a, '08-group-call-desktop');

  // Carol's phone switches between its front and back camera: the same track restarted, so
  // Alice keeps seeing it; her own isn't mirrored on the back camera. Computers get no switch.
  if (await a.locator('.group-call-panel button[aria-label="Switch camera"]').count()) throw new Error('a computer has Switch camera');
  await c.click('.group-call-panel button[aria-label="Turn on camera"]');
  const carolsTile = `.call-panel-person:has([aria-label="${carol.name}'s camera"])`;
  await cameraPlaying(a, carolsTile);
  const own = c.locator('.group-call-panel video[aria-label="Your camera"]');
  await own.waitFor();
  if (!(await own.evaluate((v) => v.classList.contains('mirrored')))) throw new Error('front camera not mirrored');
  const trackIds = () => a.locator(`${carolsTile} video`).evaluate((v) => v.srcObject?.getVideoTracks()[0]?.id);
  const before = await trackIds();
  await c.click('.group-call-panel button[aria-label="Switch camera"]');
  await c.waitForFunction(() => !document.querySelector('.group-call-panel video[aria-label="Your camera"]').classList.contains('mirrored'));
  const state = await own.evaluate((v) => v.srcObject?.getVideoTracks()[0]?.readyState);
  if (state !== 'live') throw new Error(`carol's camera after switching: ${state}`);
  await cameraPlaying(c, '.call-panel-person:has(video[aria-label="Your camera"])');
  await a.waitForTimeout(1500);
  await cameraPlaying(a, carolsTile);
  if ((await trackIds()) !== before) throw new Error('switching published the camera again');
  await shot(c, '09-group-call-phone-back-camera');
  await c.click('.group-call-panel button[aria-label="Switch camera"]');
  await c.waitForFunction(() => document.querySelector('.group-call-panel video[aria-label="Your camera"]').classList.contains('mirrored'));
  console.log('carol (phone) switched to the back camera and back; alice kept seeing it');
  await a.click('.group-call-panel button[aria-label="Leave call"]');
  console.log('OK');
} finally {
  await browser.close();
}
