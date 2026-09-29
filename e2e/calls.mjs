// DM voice calls in real browsers, through the e2e LiveKit: Alice calls Bob from their chat,
// Bob's app rings (from another page) and he answers; LiveKit is asked how the tracks are
// encrypted (end to end, so it only forwards ciphertext) and Bob's side checks Alice's audio
// actually decrypts to sound. Answering opens the chat with the caller. Mute shows on the other side, hanging up ends it for both,
// declining tells the caller. Carol answers on a phone.
//   node e2e/serve.mjs &   then   node e2e/calls.mjs [screenshot dir]
// (E2E_API_PORT too when serve.mjs isn't on the default ports: it reads LiveKit's keys.)
import { readFileSync } from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { launchChrome, signUp, openChat, devices, fakeMicArgs, livekitInfoPath, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const livekit = JSON.parse(readFileSync(livekitInfoPath(), 'utf8'));
const roomService = new RoomServiceClient(livekit.url, livekit.key, livekit.secret);

const currentCall = (page) => page.evaluate(async () => {
  const res = await fetch('/api/dm-calls/current', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  return res.json();
});

// The loudest sample of the other person's audio over ~1.5 s, as this page hears it (after
// decryption: with the wrong key it's silence).
const heardLevel = (page) => page.evaluate(async () => {
  const element = document.querySelector('[data-voice-audio] audio');
  if (!element?.srcObject) return -1;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  context.createMediaStreamSource(element.srcObject).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let max = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 50));
    analyser.getFloatTimeDomainData(samples);
    for (const v of samples) max = Math.max(max, Math.abs(v));
  }
  await context.close();
  return max;
});

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
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated/.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
  }

  // Bob is elsewhere (his chat with Carol) when Alice calls.
  await openChat(b, carol.id);
  await openChat(a, bob.id);
  const callButton = `button[aria-label="Call ${bob.name}"]:not([disabled])`;
  await a.waitForSelector(callButton);
  await shot(a, '01-dm-with-call-button');
  await a.click(callButton);
  await a.waitForSelector('.call-panel:has-text("Calling…")');
  await b.waitForSelector(`.incoming-call:has-text("${alice.name}")`);
  console.log('alice is calling; bob\'s app rings');
  await shot(a, '02-alice-calling');
  await shot(b, '03-bob-incoming');

  await b.click('.incoming-call button[aria-label="Accept"]');
  await b.waitForSelector('.voice-bar-status.connected:has-text("Call Connected")', { timeout: 20000 });
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  console.log('bob answered: both connected');

  // LiveKit only sees encrypted audio.
  const call = await currentCall(a);
  await a.waitForTimeout(1500);
  const participants = await roomService.listParticipants(`call-${call.id}`);
  const tracks = participants.flatMap((p) => p.tracks.map((t) => ({ who: p.identity, encryption: t.encryption })));
  console.log('tracks in LiveKit:', JSON.stringify(tracks));
  if (tracks.length !== 2 || tracks.some((t) => !t.encryption)) throw new Error('call audio is not end-to-end encrypted');

  // ...and Bob's side decrypts it to sound.
  await b.waitForFunction(() => [...document.querySelectorAll('[data-voice-audio] audio')].some((el) => el.currentTime > 0.5), null, { timeout: 10000 });
  const level = await heardLevel(b);
  console.log('bob hears alice at level', level.toFixed(3));
  if (!(level > 0.01)) throw new Error('bob hears nothing (decryption failed?)');

  // Answering took Bob to his chat with Alice: the call panel is there, with Alice talking.
  // (No page loads from here on: leaving the page leaves the call.)
  await b.waitForURL(`**/dm/${alice.id}`);
  await b.waitForSelector('.call-panel .user-avatar.speaking', { timeout: 15000 });
  await shot(b, '04-bob-in-call');
  await a.click('.call-panel button[aria-label="Mute"]');
  await b.waitForSelector('.call-panel [aria-label="Muted"]');
  console.log('alice muted: bob sees it');
  await shot(b, '05-bob-sees-alice-muted');
  await a.click('.call-panel button[aria-label="Unmute"]');

  await b.click('.call-panel button[aria-label="Hang up"]');
  await a.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });
  await a.waitForSelector('.voice-bar', { state: 'detached' });
  if (await currentCall(a)) throw new Error('call still exists after hanging up');
  console.log('bob hung up: gone for both');

  // Declining tells the caller.
  await a.click(callButton);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Decline"]');
  await a.waitForSelector(`.voice-bar-message:has-text("${bob.name} declined the call.")`);
  await a.waitForSelector('.call-panel', { state: 'detached' });
  console.log('declined: alice is told');
  await shot(a, '06-alice-declined');
  await a.click('.voice-bar button[aria-label="Dismiss"]');

  // Carol, on a phone, answers from the chat list.
  await c.goto(`${BASE}/dm`);
  await openChat(a, carol.id);
  await a.click(`button[aria-label="Call ${carol.name}"]:not([disabled])`);
  await c.waitForSelector('.incoming-call');
  await shot(c, '07-carol-phone-incoming');
  await c.click('.incoming-call button[aria-label="Accept"]');
  await c.waitForURL(`**/dm/${alice.id}`);
  await c.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await c.waitForSelector('.call-panel .user-avatar.speaking', { timeout: 15000 });
  await c.waitForTimeout(700);
  await shot(c, '08-carol-phone-in-call');
  console.log('carol answered on her phone');
  await a.click('.voice-bar button[aria-label="Hang up"]');
  await c.waitForSelector('.call-panel', { state: 'detached', timeout: 10000 });
  console.log('OK');
} finally {
  await browser.close();
}
