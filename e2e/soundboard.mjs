// Soundboards in real browsers, through the e2e LiveKit: Alice adds sounds in Guild Settings →
// Soundboard (a 1 s WAV as it is, and an 8 s one cut to the 5.2 s chosen), gives one an emoji;
// Alice and Bob join a voice channel and Bob plays a sound from the voice bar: both their pages
// play it (each locally, cut at 5.2 s), and its emoji pops up on Bob's tile. With "Play
// soundboard sounds" off in Settings, Alice hears none while Bob still does. Carol, on a phone,
// opens the soundboard as a sheet, picks a join sound, and joining the channel plays it for the
// others, Alice included (her soundboard sounds are off, join sounds on). Deafened, the
// soundboard says so and its sounds can't be played.
//   node e2e/serve.mjs &   then   node e2e/soundboard.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// A mono 16-bit WAV of a `seconds` long tone.
function toneWav(file, seconds, frequency = 440) {
  const rate = 22050;
  const count = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + count * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000), 44 + i * 2);
  fs.writeFileSync(file, bytes);
  return file;
}

// Every buffer source the page starts (soundboard sounds are the ones longer than 0.9 s):
// { duration (the buffer's), length (how long it's told to play) }.
const RECORD = () => {
  window.__clips = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
    window.__clips.push({ duration: this.buffer?.duration ?? 0, length: duration ?? null });
    return start.apply(this, arguments);
  };
};
const clips = (page) => page.evaluate(() => window.__clips.filter((c) => c.duration > 0.9));
async function waitForClips(page, count, what) {
  try {
    await page.waitForFunction((n) => window.__clips.filter((c) => c.duration > 0.9).length >= n, count, { timeout: 8000 });
  } catch {
    throw new Error(`${what}: expected ${count} sounds, got ${JSON.stringify(await clips(page))}`);
  }
}
const noMoreClips = async (page, count, what) => {
  await page.waitForTimeout(1500);
  const got = await clips(page);
  if (got.length !== count) throw new Error(`${what}: expected ${count} sounds, got ${JSON.stringify(got)}`);
};

const tile = (name) => `.voice-tile:has-text("${name}")`;
// Goes to `to` inside the app (a reload would leave voice).
const navigate = (page, to) => page.evaluate((url) => {
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, to);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-sounds-'));
const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    await page.addInitScript(RECORD);
    await page.evaluate(RECORD);
    page.on('response', (r) => {
      if (r.status() >= 400) console.log(`[${who} ${r.status()}]`, r.request().method(), r.url().replace(BASE, ''));
    });
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Sound Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  for (const name of ['Lounge', 'Quiet']) {
    await a.click('.guild-header-button');
    await a.click('text=Create Channel');
    await a.click('label:has-text("Voice")');
    await a.fill('#channel-name', name);
    await a.click('button:has-text("Create channel")');
    await a.waitForSelector('.voice-view-join');
  }
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = (await a.inputValue('#invite-link')).replace(/^https?:\/\/[^/]+/, BASE);
  await a.keyboard.press('Escape');
  for (const page of [b, c]) {
    await page.goto(link);
    await page.click('button:has-text("Accept invite")');
    await page.waitForSelector('#dm-input, .guild-channel-link', { timeout: 15000 });
  }

  // Guild Settings → Soundboard: a short WAV goes up as it is.
  await a.click('.guild-header-button');
  await a.click('text=Guild Settings');
  await a.click('.settings-tab:has-text("Soundboard")');
  await a.setInputFiles('input[aria-label="Sound file"]', toneWav(path.join(dir, 'ding_dong.wav'), 1));
  await a.waitForSelector('.soundboard-settings-new');
  if (await a.$('.soundboard-settings-trim')) throw new Error('a 1 s sound offered trimming');
  if (await a.inputValue('.soundboard-settings-new input[aria-label="Name"]') !== 'ding dong') throw new Error('not named after the file');
  await a.click('button:has-text("Add sound")');
  await a.waitForSelector('.soundboard-settings-row input[value="ding dong"]');
  console.log('a 1 s WAV added as it is');

  // An 8 s one: cut to the 5.2 s chosen (a slider for where it starts).
  await a.setInputFiles('input[aria-label="Sound file"]', toneWav(path.join(dir, 'long one.wav'), 8, 660));
  await a.waitForSelector('.soundboard-settings-trim');
  await a.$eval('.soundboard-settings-trim input', (el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const range = await a.textContent('.soundboard-settings-trim .vc-hint');
  if (!range.includes('2.0 s to 7.2 s')) throw new Error(`trim range reads ${range}`);
  await shot(a, '01-settings-new-sound-trim');
  await a.click('button:has-text("Add sound")');
  await a.waitForSelector('.soundboard-settings-row input[value="long one"]');
  console.log('an 8 s WAV cut to 2.0–7.2 s');

  // An emoji for the first one, from the picker.
  await a.click('.soundboard-settings-row:has(input[value="ding dong"]) .soundboard-settings-emoji');
  await a.waitForSelector('.emoji-picker-item');
  await a.click('.emoji-picker-item >> nth=0');
  await a.waitForSelector('.soundboard-settings-row:has(input[value="ding dong"]) .soundboard-settings-emoji img.emoji');
  console.log('emoji set');
  await shot(a, '02-settings-list');
  await a.keyboard.press('Escape');

  // Alice and Bob in Lounge; Bob plays "long one" from the voice bar.
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.voice-bar .soundboard-toggle');
  await b.waitForSelector('.soundboard-panel .soundboard-sound:has-text("long one")');
  await shot(b, '03-panel');
  await b.click('.soundboard-panel .soundboard-sound:has-text("long one")');
  await waitForClips(a, 1, 'alice hears bob\'s sound');
  await waitForClips(b, 1, 'bob hears his own sound');
  const [heard] = await clips(a);
  if (Math.abs(heard.duration - 5.2) > 0.05) throw new Error(`the cut sound is ${heard.duration} s`);
  if (heard.length == null || heard.length > 5.25) throw new Error(`played for ${heard.length} s, not at most 5.2`);
  console.log('both hear it, 5.2 s long:', JSON.stringify(heard));

  // Its emoji (none: a note) pops up on Bob's tile on Alice's page; "ding dong"'s is the emoji.
  await b.click('.soundboard-panel .soundboard-sound:has-text("ding dong")');
  await a.waitForSelector(`${tile(bob.name)} .voice-tile-effect img.emoji`, { timeout: 5000 });
  await shot(a, '04-tile-effect');
  console.log('the emoji shows on bob\'s tile');
  await waitForClips(a, 2, 'alice hears the second');

  // Preview: only Bob.
  await b.click('.soundboard-panel .soundboard-item:has-text("ding dong") .soundboard-preview');
  await waitForClips(b, 3, 'bob previews');
  await noMoreClips(a, 2, 'a preview reaches only bob');
  console.log('a preview plays only for bob');

  // Alice turns soundboard sounds off (Settings → Voice & video): Bob still hears his.
  const loungePath = new URL(a.url()).pathname;
  await navigate(a, '/settings/voice-video#soundboard');
  await a.waitForSelector('#settings-soundboard');
  await a.locator('label:has-text("Play soundboard sounds") input').uncheck();
  await a.locator('#settings-soundboard').scrollIntoViewIfNeeded();
  await shot(a, '05-settings-voice');
  await navigate(a, loungePath);
  await a.waitForSelector('.voice-view-controls');
  await b.click('.soundboard-panel .soundboard-sound:has-text("ding dong")');
  await waitForClips(b, 4, 'bob hears it');
  await noMoreClips(a, 2, 'alice has soundboard sounds off');
  console.log('with soundboard sounds off alice hears none, bob does');

  // Deafened: the panel says so and its buttons are off. (Deafening is a click outside it,
  // which closes it.)
  await b.click('.user-panel button[aria-label="Deafen"]');
  await b.waitForSelector('.soundboard-panel', { state: 'detached' });
  await b.click('.voice-bar .soundboard-toggle');
  await b.waitForSelector('.soundboard-note:has-text("Undeafen")');
  if (!(await b.$eval('.soundboard-panel .soundboard-sound', (el) => el.disabled))) throw new Error('sounds playable deafened');
  await b.click('.user-panel button[aria-label="Undeafen"]');
  await b.keyboard.press('Escape');
  await b.waitForSelector('.soundboard-panel', { state: 'detached' });
  console.log('deafened: the soundboard says to undeafen');

  // Carol, on a phone, in Quiet: the soundboard is a sheet; she picks a join sound.
  await c.goto(`${BASE}${await a.getAttribute('.guild-channel-link:has-text("quiet")', 'href')}`);
  await c.evaluate(RECORD);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls .soundboard-toggle', { timeout: 20000 });
  await c.click('.voice-view-controls .soundboard-toggle');
  await c.waitForSelector('.soundboard-sheet .soundboard-sound:has-text("ding dong")');
  await c.selectOption('.soundboard-sheet select', { label: 'ding dong' });
  await c.waitForSelector('.soundboard-sheet .soundboard-item:has-text("ding dong") .soundboard-join-mark');
  await shot(c, '06-phone-sheet');
  await c.click('.action-sheet-backdrop', { position: { x: 10, y: 10 } });
  console.log('carol picked a join sound on her phone');

  // She moves to Lounge: Bob hears her join sound; Alice (soundboard off, join sounds on) does too.
  const before = { a: (await clips(a)).length, b: (await clips(b)).length };
  await c.goto(`${BASE}${loungePath}`);
  await c.click('.voice-view-join');
  await waitForClips(b, before.b + 1, 'bob hears carol\'s join sound');
  await waitForClips(a, before.a + 1, 'alice hears carol\'s join sound');
  console.log('carol\'s join sound plays for alice and bob');

  console.log('ok');
} finally {
  await browser.close();
}
