// Noise suppression and the gate (src/voice/noise/), in Chrome: first the real worklets on a
// made-up recording (a fan with key clicks, then a voice-like sound over them, then clicks
// alone), rendered through each mode with an OfflineAudioContext and measured: with the gate
// automatic, noise and clicks are silenced and the voice gets through; with the gate open,
// what each mode removes from the noise by itself; and how fast each runs (DeepFilterNet must
// be well within real time). Then Settings → Voice & video with the fake mic: Standard by
// default, the mic test heard through the gate, input sensitivity by hand (the meter, a
// threshold above the voice silences it), Strong in the mic test, and the phone layout.
//   node e2e/serve.mjs &   then   node e2e/noise.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

const goTo = (page, path) => page.evaluate((p) => {
  history.pushState({}, '', p);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);

// In the page: renders the made-up recording through each mode and measures it.
async function measureModes(page) {
  return page.evaluate(async () => {
    const { voiceProcessingStage, VOICE_SAMPLE_RATE: RATE } = await import('/src/voice/noise/noiseStages.js');
    const SECONDS = 12;
    const length = RATE * SECONDS;
    let seed = 42;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647 - 0.5;
    };
    const fan = new Float32Array(length);
    const clicks = new Float32Array(length);
    const voice = new Float32Array(length);
    let low = 0;
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / RATE;
      low += 0.05 * (random() - low);
      if (t < 8) fan[i] = low * 0.15;
      if (t >= 4 && t < 8) {
        const envelope = (Math.floor(t * 4) % 4 === 3 ? 0 : Math.sin(Math.PI * ((t * 4) % 1)) ** 2);
        // A pitch that wanders like a voice, its harmonics shaped by two moving formants.
        const pitch = 120 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(2 * Math.PI * 3.1 * t);
        phase += (2 * Math.PI * pitch) / RATE;
        const f1 = 500 + 300 * Math.sin(2 * Math.PI * 0.9 * t);
        const f2 = 1500 + 600 * Math.sin(2 * Math.PI * 1.3 * t);
        let sample = 0;
        for (let h = 1; h <= 30; h++) {
          const f = h * pitch;
          const weight = Math.exp(-(((f - f1) / 300) ** 2)) + 0.5 * Math.exp(-(((f - f2) / 400) ** 2)) + 0.05;
          sample += weight * Math.sin(h * phase);
        }
        voice[i] = 0.25 * envelope * sample;
      }
    }
    // Key clicks: a sharp tick and a short ring, every ~150 ms, of varying strength.
    for (let start = 0.05 * RATE; start < length; start += Math.round((0.12 + 0.06 * (random() + 0.5)) * RATE)) {
      const strength = 0.2 + 0.3 * (random() + 0.5);
      for (let j = 0; j < 0.03 * RATE && start + j < length; j++) {
        const t = j / RATE;
        clicks[start + j] += strength * (random() * 2 * Math.exp(-t / 0.002) + Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t / 0.008));
      }
    }
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) input[i] = fan[i] + clicks[i] + voice[i];

    const db = (samples, from, to) => {
      let sum = 0;
      const a = Math.floor(from * RATE);
      const b = Math.floor(to * RATE);
      for (let i = a; i < b; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / (b - a));
      return rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -200;
    };
    const parts = (samples) => ({
      noise: db(samples, 0.5, 4), voice: db(samples, 4.5, 7.9), clicks: db(samples, 8.5, 12),
    });

    const results = { input: parts(input), voiceAlone: db(voice, 4.5, 7.9), modes: {} };
    for (const mode of ['off', 'browser', 'standard', 'strong']) {
      for (const gate of ['auto', 'open']) {
        const context = new OfflineAudioContext(1, length, RATE);
        const settings = { noiseSuppression: mode, autoSensitivity: gate === 'auto', sensitivity: -100 };
        const stage = await voiceProcessingStage(context, { settings });
        const buffer = context.createBuffer(1, length, RATE);
        buffer.copyToChannel(input, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(stage.input);
        stage.output.connect(context.destination);
        source.start();
        const started = performance.now();
        const rendered = await context.startRendering();
        const seconds = (performance.now() - started) / 1000;
        stage.destroy?.();
        results.modes[`${mode}/${gate}`] = { ...parts(rendered.getChannelData(0)), realtime: Math.round((seconds / SECONDS) * 1000) / 1000 };
      }
    }
    return results;
  });
}

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  const fellBack = [];
  a.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[alice ${m.type()}]`, m.text().slice(0, 200));
    if (/Strong noise suppression unavailable|too slow on this device/.test(m.text())) fellBack.push(m.text());
  });
  a.on('pageerror', (e) => console.log('[alice] page error:', e.message));

  // The worklets on the made-up recording.
  const r = await measureModes(a);
  console.log('input (dB):', JSON.stringify(r.input), 'voice alone:', r.voiceAlone);
  for (const [name, m] of Object.entries(r.modes)) {
    console.log(`${name.padEnd(16)} noise ${String(m.noise).padStart(7)}  voice ${String(m.voice).padStart(7)}  clicks ${String(m.clicks).padStart(7)}  render ${m.realtime}× real time`);
  }
  const fail = (why) => { throw new Error(why); };
  if (fellBack.length) fail(`Strong fell back to Standard: ${fellBack[0]}`);
  for (const mode of ['off', 'browser', 'standard', 'strong']) {
    const auto = r.modes[`${mode}/auto`];
    if (auto.noise > -70) fail(`${mode}: the gate let the fan and clicks through (${auto.noise} dB)`);
    if (auto.clicks > -70) fail(`${mode}: the gate let clicks alone through (${auto.clicks} dB)`);
    if (auto.voice < r.voiceAlone - 8) fail(`${mode}: the voice was cut (${auto.voice} dB, alone ${r.voiceAlone} dB)`);
  }
  const open = (mode) => r.modes[`${mode}/open`];
  if (Math.abs(open('off').noise - r.input.noise) > 1) fail('off changed the sound');
  if (open('standard').noise > open('off').noise - 10) fail('Standard removed under 10 dB of fan and clicks');
  if (open('strong').noise > open('off').noise - 20) fail('Strong removed under 20 dB of fan and clicks');
  if (open('strong').clicks > open('standard').clicks) fail('Strong removed fewer clicks than Standard');
  // About 0.5 on the Intel N100 (a low-power mini-PC chip) this was written on; the app steps
  // aside for Standard at 0.8.
  if (r.modes['strong/open'].realtime > 0.7) fail(`DeepFilterNet too slow here (${r.modes['strong/open'].realtime}× real time)`);
  console.log('worklets: gate silences noise and clicks, keeps the voice; Standard and Strong remove noise; DeepFilterNet fast enough');

  // Settings → Voice & video.
  await goTo(a, '/settings#voice-video');
  await a.waitForSelector('.voice-settings');
  if (!(await a.isChecked('input[name="noise-suppression"][value="standard"]'))) fail('Standard is not the default');
  if (await a.isDisabled('input[name="noise-suppression"][value="strong"]')) fail('Strong is unavailable on a computer');
  if (!(await a.isChecked('label:has-text("Automatic") input'))) fail('automatic sensitivity is not the default');
  await a.click('button:has-text("Let\'s check")');
  await a.waitForFunction(() => Number(document.querySelector('.mic-test-meter')?.getAttribute('aria-valuenow')) > 30, null, { timeout: 10000 });
  console.log('mic test: the fake voice gets through the gate');

  // By hand: the meter shows the level; a threshold above it silences the mic.
  await a.uncheck('label:has-text("Automatic") input');
  await a.waitForSelector('input[aria-label="Input sensitivity"]');
  await a.waitForFunction(() => Number(document.querySelector('.voice-sensitivity-meter')?.getAttribute('aria-valuenow')) > -60, null, { timeout: 5000 });
  const setRange = (label, value) => a.$eval(`input[aria-label="${label}"]`, (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await setRange('Input sensitivity', '-60');
  await a.waitForSelector('.voice-sensitivity-level.open', { timeout: 5000 });
  await shot(a, '01-sensitivity-by-hand');
  await setRange('Input sensitivity', '0');
  await a.waitForTimeout(800);
  const quiet = await a.evaluate(async () => {
    let max = 0;
    for (let i = 0; i < 20; i++) {
      max = Math.max(max, Number(document.querySelector('.mic-test-meter').getAttribute('aria-valuenow')));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return max;
  });
  if (quiet > 0) fail(`threshold at 0 dB still sends (${quiet})`);
  console.log('by hand: the meter shows the level, a threshold above the voice silences it');
  await a.check('label:has-text("Automatic") input');

  // Strong in the mic test (restarts it, loads DeepFilterNet).
  await a.check('input[name="noise-suppression"][value="strong"]');
  await a.waitForFunction(() => Number(document.querySelector('.mic-test-meter')?.getAttribute('aria-valuenow')) > 30, null, { timeout: 20000 });
  if (fellBack.length) fail(`Strong fell back to Standard in the mic test: ${fellBack[0]}`);
  console.log('Strong: the mic test still hears the voice');
  await shot(a, '02-strong');
  await a.click('button:has-text("Stop testing")');
  await a.click('button:has-text("Reset voice settings")');
  if (!(await a.isChecked('input[name="noise-suppression"][value="standard"]'))) fail('reset did not go back to Standard');

  // Phone.
  const phone = await signUp(browser, 'phil', { ...devices['Pixel 7'] });
  await goTo(phone.page, '/settings#voice-video');
  await phone.page.waitForSelector('.voice-settings');
  const strongOnPhone = await phone.page.isDisabled('input[name="noise-suppression"][value="strong"]');
  console.log(`phone: Strong ${strongOnPhone ? 'unavailable' : 'offered (the emulated phone reports itself as a computer)'}`);
  await phone.page.$eval('.voice-settings', (el) => el.scrollIntoView());
  await shot(phone.page, '03-phone');
  console.log('noise suppression: all good');
} finally {
  await browser.close();
}
