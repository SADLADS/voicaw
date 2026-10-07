// Stream volume in real browsers, through the e2e LiveKit: Alice shares her screen with sound
// (Chrome's fake screen, its sound a steady tone made in the page) and keeps her microphone
// muted, so the only sound Bob gets from her is the stream's. Bob watches and sets the stream's
// volume in its bar; how loud it really plays is measured from his Web Audio graph (as in
// uservolume.mjs): 100%, 50%, 200%, muted (0), unmuted (back to 200%), deafened (silent,
// controls greyed), and Alice's own User Volume not touching it. Kept after a reload, and in the
// popped-out window too. Alice's own stream has no volume. Carol, on a phone, sees the slider.
//   node e2e/serve.mjs &   then   node e2e/streamvolume.mjs [screenshot dir]
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

// The same taps as uservolume.mjs: an analyser before and after each played voice's gains.
const tapOutput = () => {
  window.__taps = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function tapped(target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (this instanceof MediaStreamAudioSourceNode && target instanceof GainNode) {
      const input = this.context.createAnalyser();
      input.fftSize = 2048;
      connect.call(this, input);
      target.__input = input;
    } else if (this.__input && target instanceof GainNode) {
      target.__input = this.__input;
    }
    if (this.__input && target instanceof AudioDestinationNode && !this.__tapped) {
      this.__tapped = true;
      const output = this.context.createAnalyser();
      output.fftSize = 2048;
      connect.call(this, output);
      window.__taps.push({ input: this.__input, output });
    }
    return result;
  };
};

const level = (page, ms = 1500) => page.evaluate(async (ms) => {
  const rms = (analyser) => {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
  };
  const end = performance.now() + ms;
  let sumIn = 0;
  let sumOut = 0;
  let frames = 0;
  while (performance.now() < end) {
    for (const { input, output } of window.__taps ?? []) {
      if (input.context.state === 'closed') continue;
      const i = rms(input);
      if (i < 0.01) continue;
      sumIn += i;
      sumOut += rms(output);
      frames++;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return { out: frames ? sumOut / frames : 0, ratio: sumIn ? sumOut / sumIn : 0 };
}, ms);

// The level once it has settled on `want` (LiveKit takes a moment to start the stream's sound).
async function settledLevel(page, want) {
  let last;
  for (let i = 0; i < 8; i++) {
    last = await level(page);
    if (near(last.ratio, want)) return last;
  }
  return last;
}

const near = (ratio, want) => Math.abs(ratio - want) < 0.1 * Math.max(1, want);

const setSlider = (page, sel, value) => page.$eval(sel, (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log('ok:', what);
}

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

const tile = (name) => `.voice-tile:has-text("${name}")`;
const slider = '.stream-view .stream-volume-slider';
const muteButton = '.stream-view button[aria-label="Mute the stream"]';
const unmuteButton = '.stream-view button[aria-label="Unmute the stream"]';

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
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated/.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
    await page.context().addInitScript(tapOutput);
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Stream Volume');
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
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  if (await a.$('.user-panel button[aria-label="Mute"]')) await a.click('.user-panel button[aria-label="Mute"]');
  await a.waitForSelector('.user-panel button[aria-label="Unmute"]');
  await a.waitForSelector(tile(bob.name));

  // Alice's screen with sound: Chrome's fake screen has none, so a tone is added to it.
  await a.evaluate(() => {
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      const stream = await original({ ...options, audio: false });
      const context = new AudioContext();
      const tone = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.3;
      const out = context.createMediaStreamDestination();
      tone.connect(gain).connect(out);
      tone.start();
      window.__tone = context;
      return new MediaStream([...stream.getVideoTracks(), ...out.stream.getAudioTracks()]);
    };
  });
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")'); // the quality dialog first
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await videoPlaying(a);
  check(!(await a.$('.stream-view .stream-volume')), "Alice's own stream has no volume");

  await b.waitForSelector(`${tile(alice.name)} .voice-tile-watch`, { timeout: 10000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  check(await b.$eval(slider, (el) => el.value) === '100', 'the slider starts at 100%');

  const full = await settledLevel(b, 1);
  console.log('100%:', JSON.stringify(full));
  check(full.out > 0.01 && near(full.ratio, 1), "Bob hears the stream's sound at 100%");

  // The slider is hidden until the pointer is over the speaker button.
  const hiddenWidth = await b.$eval(slider, (el) => el.getBoundingClientRect().width);
  await b.hover('.stream-view .stream-volume');
  await b.waitForFunction((sel) => document.querySelector(sel).getBoundingClientRect().width > 60, slider);
  check(hiddenWidth < 1, 'the slider shows on hover');
  await shot(b, '01-bob-stream-volume-hover');

  await setSlider(b, slider, 50);
  const half = await settledLevel(b, 0.5);
  console.log('50%:', JSON.stringify(half));
  check(near(half.ratio, 0.5), 'at 50% it plays at half');

  await setSlider(b, slider, 200);
  const boosted = await settledLevel(b, 2);
  console.log('200%:', JSON.stringify(boosted));
  check(near(boosted.ratio, 2), 'at 200% it plays twice as loud');
  await shot(b, '02-bob-stream-volume-200');

  await b.click(muteButton);
  await b.waitForTimeout(500); // what the analysers still hold from before
  const muted = await level(b);
  console.log('muted:', JSON.stringify(muted));
  check(muted.ratio < 0.02, 'muted is silent');
  check(await b.$eval(slider, (el) => el.value) === '0', 'muted puts the slider at 0');
  await shot(b, '03-bob-stream-muted');
  await b.click(unmuteButton);
  const unmuted = await settledLevel(b, 2);
  check(near(unmuted.ratio, 2), 'unmuting goes back to 200%');

  // Her User Volume is her voice's, not her stream's.
  await b.evaluate((id) => {
    localStorage.setItem('userVolumes', JSON.stringify({ [id]: 0.5 }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'userVolumes' }));
  }, String(alice.id));
  const withUserVolume = await settledLevel(b, 2);
  console.log('with her User Volume at 50%:', JSON.stringify(withUserVolume));
  check(near(withUserVolume.ratio, 2), "her User Volume doesn't change the stream's");

  await b.click('.user-panel button[aria-label="Deafen"]');
  await b.waitForTimeout(500);
  const deaf = await level(b);
  check(deaf.ratio < 0.02, 'deafened is silent');
  check(await b.$eval(slider, (el) => el.disabled) && await b.$eval(unmuteButton, (el) => el.disabled), 'deafened, the controls are greyed out');
  await shot(b, '04-bob-deafened');
  await b.click('.user-panel button[aria-label="Undeafen"]');
  check(near((await settledLevel(b, 2)).ratio, 2), 'undeafened is back at 200%');

  // Kept after a reload (rejoin and watch again).
  await b.reload();
  await b.waitForSelector('.voice-view-join', { timeout: 20000 });
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  check(await b.$eval(slider, (el) => el.value) === '200', 'kept after a reload');
  check(near((await settledLevel(b, 2)).ratio, 2), 'and still plays at 200%');

  // Popped out: the same control in the window.
  const [popup] = await Promise.all([
    b.waitForEvent('popup'),
    b.click('.stream-view button[aria-label="Pop out"]'),
  ]);
  await popup.waitForSelector('.stream-view.popped-out');
  await videoPlaying(popup);
  await popup.hover('.stream-view .stream-volume');
  await setSlider(popup, slider, 50);
  check(near((await settledLevel(b, 0.5)).ratio, 0.5), 'the popped-out window sets it too');
  await shot(popup, '05-popout-volume');
  await popup.click('.stream-view button[aria-label="Bring back"]');
  await b.waitForSelector('.stream-view:not(.popped-out)');

  // Carol on a phone: the slider is always there and fits.
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.waitForSelector('.voice-view-join');
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  const phone = await c.evaluate((sel) => {
    const bar = document.querySelector('.stream-bar').getBoundingClientRect();
    const s = document.querySelector(sel).getBoundingClientRect();
    return { width: s.width, inside: s.left >= bar.left && s.right <= bar.right, overflow: document.documentElement.scrollWidth > innerWidth };
  }, slider);
  console.log('phone:', JSON.stringify(phone));
  check(phone.width > 60 && phone.inside && !phone.overflow, 'on a phone the slider shows and fits');
  await shot(c, '06-carol-phone');
  console.log('OK');
} finally {
  await browser.close();
}
