// The speaking ring keeps up with the voice (measured on the device, voice/speaking.js, not
// LiveKit's active speakers): Alice and Bob in a voice channel, Alice's fake microphone talking
// in phrases (1.5 s on, 1.5 s off). On Bob's side a separate meter listens to the audio he
// actually receives from her, and the ring's comings and goings are timed against it: how long
// after she starts a phrase her ring lights, and how long after she stops it goes out, on Bob's
// screen and on her own. Muting puts her own ring out at once; Bob, deafened, still sees it.
// Prints the timings (milliseconds).
//   node e2e/serve.mjs &   then   node e2e/speaking.mjs [screenshot dir]
import { launchChrome, signUp, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const tile = (name) => `.voice-tile:has-text("${name}")`;
const median = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
const SILENCE_MS = 700; // a gap this long ends a phrase (the pauses inside one are 250 ms)

// Records when the element gains or loses .speaking, in epoch ms (both browsers run on this
// machine, so the clocks agree).
async function recordRing(page, selector) {
  const element = await page.$(selector);
  await element.evaluate((el) => {
    window.ringLog = [{ at: Date.now(), on: el.classList.contains('speaking') }];
    new MutationObserver(() => {
      const on = el.classList.contains('speaking');
      if (on !== window.ringLog.at(-1).on) window.ringLog.push({ at: Date.now(), on });
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
}

// The ground truth: when the voice Bob receives is sounding, every 5 ms, in epoch ms.
async function recordSound(page) {
  await page.evaluate(() => {
    const audio = document.querySelector('[data-voice-audio] audio');
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(audio.srcObject).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    window.soundLog = [];
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const db = 10 * Math.log10(sum / samples.length || 1e-12);
      if (db > -50) window.soundLog.push(Date.now());
    }, 5);
  });
}

// Phrases from the sound log: [{ start, end }].
function phrasesOf(sound) {
  const phrases = [];
  for (const at of sound) {
    const last = phrases.at(-1);
    if (last && at - last.end < SILENCE_MS) last.end = at;
    else phrases.push({ start: at, end: at });
  }
  return phrases.filter((p) => p.end - p.start > 500);
}

// How late the ring lit and went out for each whole phrase seen.
function lags(phrases, ring) {
  const on = [];
  const off = [];
  for (const { start, end } of phrases.slice(1, -1)) {
    const lit = ring.find((r) => r.on && r.at >= start - SILENCE_MS / 2);
    const out = ring.find((r) => !r.on && r.at >= end - SILENCE_MS / 2);
    if (lit && lit.at < end) on.push(lit.at - start);
    if (out) off.push(out.at - end);
  }
  return { on, off };
}

const browser = await launchChrome({ args: fakeMicArgs({ phrases: true }) });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  for (const [who, page] of [['alice', a], ['bob', b]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} error]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Speaking Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const loungeUrl = a.url().replace(BASE, '');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');

  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.goto(BASE + loungeUrl);
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  // Bob is muted, so only Alice talks.
  await b.click('.user-panel button[aria-label="Mute"]');
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  console.log('bob sees alice speaking');
  await a.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  console.log('alice sees her own ring');
  await shot(b, '01-bob-sees-alice-speaking');

  await recordRing(b, tile(alice.name));
  await recordRing(a, tile(alice.name));
  await recordSound(b);
  await b.waitForTimeout(16000);
  const sound = await b.evaluate(() => window.soundLog);
  const phrases = phrasesOf(sound);
  const bobRing = await b.evaluate(() => window.ringLog);
  const ownRing = await a.evaluate(() => window.ringLog);
  console.log('phrases heard by bob:', phrases.map((p) => p.end - p.start).join(', '), 'ms long');
  if (phrases.length < 4) throw new Error('not enough phrases heard');
  const seen = lags(phrases, bobRing);
  const own = lags(phrases, ownRing);
  console.log('bob\'s screen: ring lit', seen.on.join(', '), 'ms after the voice (median', median(seen.on), ')');
  console.log('bob\'s screen: ring out', seen.off.join(', '), 'ms after it stopped (median', median(seen.off), ')');
  console.log('alice\'s own: ring lit', own.on.join(', '), 'ms (median', median(own.on), ')');
  console.log('alice\'s own: ring out', own.off.join(', '), 'ms (median', median(own.off), ')');
  const outsDuringPhrases = bobRing.filter((r) => !r.on && phrases.some((p) => r.at > p.start + 100 && r.at < p.end - 100)).length;
  console.log('ring went out inside a phrase', outsDuringPhrases, 'times');
  if (median(seen.on) > 200) throw new Error('the ring lights late');
  if (median(seen.off) > 500) throw new Error('the ring goes out late');
  if (median(own.off) > 500) throw new Error('your own ring goes out late');

  // Muting puts your own ring out at once (not when LiveKit says so).
  await a.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 5000 });
  const since = Date.now();
  await a.click('.user-panel button[aria-label="Mute"]');
  await a.waitForSelector(`${tile(alice.name)}:not(.speaking)`, { timeout: 5000 });
  console.log('mute → own ring out in', Date.now() - since, 'ms');
  await a.click('.user-panel button[aria-label="Unmute"]');

  // Deafened, Bob still sees who's talking.
  await b.click('.user-panel button[aria-label="Deafen"]');
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 8000 });
  console.log('bob, deafened, still sees alice speaking');
  await shot(b, '02-deafened-still-sees-ring');
  console.log('OK');
} finally {
  await browser.close();
}
