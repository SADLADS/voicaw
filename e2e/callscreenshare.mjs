// Screen sharing in DM and group calls, through the e2e LiveKit (Chrome's fake screen). In a
// DM call Alice shares from the call panel: she sees her own stream, Bob's opens on its own and
// plays (so it decrypted), and LiveKit only has an encrypted screen track; Stop watching stops
// his download and Watch Stream brings it back; Alice stops. Then a group call: Carol, on a
// phone, sees Alice Live but downloads nothing until Watch Stream, then it plays in the panel.
//   node e2e/serve.mjs &   then   node e2e/callscreenshare.mjs [screenshot dir]
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

const recordPeerConnections = (page) => page.addInitScript(() => {
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

// The stream in `panel` plays (frames decoded: with the wrong key there are none).
const streamPlaying = (page, panel) => page.waitForFunction((selector) => {
  const v = document.querySelector(`${selector} .stream-view video`);
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, panel, { timeout: 20000 });

const currentCall = (page) => page.evaluate(async () => {
  const res = await fetch('/api/dm-calls/current', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  return res.json();
});

async function screenTracks(callId) {
  const participants = await roomService.listParticipants(`call-${callId}`);
  return participants.flatMap((p) => p.tracks.map((t) => ({ who: p.identity, source: t.source, encryption: t.encryption })))
    .filter((t) => t.source === 3 || t.source === 4); // TrackSource.SCREEN_SHARE, SCREEN_SHARE_AUDIO
}

function check(ok, what) {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

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
    await recordPeerConnections(page);
  }
  await makeFriends(alice, bob, carol);

  // A DM call.
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await b.waitForSelector('.call-panel .voice-view-controls');
  check(await a.isVisible('.voice-bar button[aria-label="Share your screen"]'), 'the voice bar offers sharing in a call');

  // Alice shares from the call panel (the quality dialog first), sees her own stream.
  await a.click('.call-panel button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await a.waitForSelector('.call-panel button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await streamPlaying(a, '.call-panel');
  console.log('alice is sharing and sees her own stream');

  // Bob's opens by itself and plays: it decrypted.
  await b.waitForSelector('.call-panel .call-panel-live', { timeout: 10000 });
  await streamPlaying(b, '.call-panel');
  check(true, "bob's view of alice's screen opened on its own and plays (decrypted)");
  const call = await currentCall(a);
  const tracks = await screenTracks(call.id);
  console.log('screen tracks in LiveKit:', JSON.stringify(tracks));
  check(tracks.some((t) => t.source === 3) && tracks.every((t) => t.encryption), 'LiveKit only has the screen share encrypted end to end');
  const size = await b.locator('.call-panel .stream-view').boundingBox();
  const viewport = b.viewportSize();
  check(size.width > viewport.width * 0.3 && size.height <= viewport.height * 0.41, `the stream fits the panel (${Math.round(size.width)}×${Math.round(size.height)})`);
  const box = await b.locator('#dm-input').boundingBox();
  check(box && box.y + box.height <= viewport.height, 'the whole message box is still on screen under the stream');
  await shot(a, '01-dm-own-stream');
  await shot(b, '02-dm-watching');

  // Stop watching: no more video; it doesn't reopen by itself. Watch Stream brings it back.
  await b.click('.call-panel .stream-view button[aria-label="Stop watching"]');
  await b.waitForSelector('.call-panel .stream-view', { state: 'detached' });
  await b.waitForTimeout(1500);
  check(await videoReceivedOver(b, 2000) < 5000, 'stopped watching: nothing downloaded');
  check(!(await b.isVisible('.call-panel .stream-view')), "it doesn't reopen by itself");
  await shot(b, '03-dm-watch-button');
  await b.click('.call-panel button:has-text("Watch Stream")');
  await streamPlaying(b, '.call-panel');
  check(true, 'Watch Stream brings it back');

  // Alice stops: Bob's view goes.
  await a.click('.call-panel button[aria-label="Stop sharing your screen"]');
  await b.waitForSelector('.call-panel .stream-view', { state: 'detached', timeout: 10000 });
  await b.waitForSelector('.call-panel .call-panel-live', { state: 'detached' });
  check(true, 'alice stopped: the stream is gone for bob');
  await b.click('.call-panel button[aria-label="Hang up"]');
  await a.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });

  // A group call: Carol (phone) waits for Watch Stream.
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Streams');
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await a.click('button[aria-label="Start a group call"]');
  await c.waitForSelector('.incoming-call', { timeout: 15000 });
  await c.click('.incoming-call button[aria-label="Accept"]');
  await c.waitForSelector('.group-call-panel .voice-view-controls', { timeout: 20000 });
  check(!(await c.isVisible('.group-call-panel button[aria-label="Share your screen"]')), "a phone isn't offered sharing");
  await a.waitForSelector('.group-call-panel button[aria-label="Share your screen"]', { timeout: 20000 });
  await a.click('.group-call-panel button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await streamPlaying(a, '.group-call-panel');
  await c.waitForSelector('.group-call-panel .call-panel-live', { timeout: 10000 });
  await c.waitForSelector('.group-call-panel button:has-text("Watch Stream")');
  check(!(await c.isVisible('.group-call-panel .stream-view')), "carol's doesn't open by itself");
  check(await videoReceivedOver(c, 2000) < 5000, 'carol downloads nothing before Watch Stream');
  await shot(c, '04-group-phone-live');
  await c.click('.group-call-panel button:has-text("Watch Stream")');
  await streamPlaying(c, '.group-call-panel');
  check(true, 'carol (phone) watches it in the panel');
  const phone = await c.locator('.group-call-panel .stream-view').boundingBox();
  check(phone.x >= 0 && phone.x + phone.width <= c.viewportSize().width + 1, 'the stream fits the phone');
  await c.waitForTimeout(500);
  await shot(c, '05-group-phone-watching');
  await shot(a, '06-group-desktop');
  await a.click('.group-call-panel button[aria-label="Leave call"]');
  console.log('OK');
} finally {
  await browser.close();
}
