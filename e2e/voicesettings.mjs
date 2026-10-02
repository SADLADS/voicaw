// Voice settings (Settings → Voice & video), with Chrome's fake microphones and speakers and
// the e2e LiveKit: the devices are listed, the mic test's meter moves; then in a voice channel,
// Alice's input volume at 0 silences her for Bob (her "speaking" ring goes out) and back at
// 100% she's heard again; a new microphone and each noise suppression (Strong, Off, Standard) keep her heard;
// Bob's output volume and speakers apply to the voices he's playing. Phone layout at the end.
//   node e2e/serve.mjs &   then   node e2e/voicesettings.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

// Moves within the app (a reload would leave the voice channel).
const goTo = (page, path) => page.evaluate((p) => {
  history.pushState({}, '', p);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);

async function openVoiceSettings(page) {
  await goTo(page, '/settings#voice-video');
  await page.waitForSelector('.voice-settings');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Input device"]')?.options.length > 1);
}

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const tile = (name) => `.voice-tile:has-text("${name}")`;

// Others' voices play through Web Audio (a gain per voice, see voiceClient.js): remembers
// those gains (a MediaStream source into a gain into the speakers) as `window.__voiceGains`.
const markVoiceGains = () => {
  window.__voiceGains = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function marked(target, ...rest) {
    if (this instanceof MediaStreamAudioSourceNode && target instanceof GainNode) target.__voice = true;
    if (this.__voice && target instanceof AudioDestinationNode && !window.__voiceGains.includes(this)) window.__voiceGains.push(this);
    return connect.call(this, target, ...rest);
  };
};
// Each voice playing: its gain, and the speakers its AudioContext plays to.
const voiceOutputs = (page) => page.evaluate(() => window.__voiceGains
  .filter((g) => g.context.state !== 'closed')
  .map((g) => ({ volume: Math.round(g.gain.value * 100) / 100, sinkId: g.context.sinkId })));

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  for (const [who, page] of [['alice', a], ['bob', b]]) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => console.log(`[${who}] page error:`, e.message));
    await page.context().addInitScript(markVoiceGains);
    await page.reload();
    await page.waitForSelector('#dm-main');
  }

  // Settings: devices listed (Chrome's fake ones), the mic test's meter moves.
  await openVoiceSettings(a);
  const inputs = await a.$$eval('select[aria-label="Input device"] option', (o) => o.map((x) => [x.value, x.textContent]));
  const outputs = await a.$$eval('select[aria-label="Output device"] option', (o) => o.map((x) => [x.value, x.textContent]));
  console.log('inputs:', inputs.map(([, t]) => t).join(' | '));
  console.log('outputs:', outputs.map(([, t]) => t).join(' | '));
  if (inputs.length < 2) throw new Error('no microphones listed');
  await a.click('button:has-text("Let\'s check")');
  await a.waitForFunction(() => Number(document.querySelector('.mic-test-meter')?.getAttribute('aria-valuenow')) > 30, null, { timeout: 10000 });
  console.log('mic test: the meter moves');
  await shot(a, '01-voice-settings-testing');
  // Input volume 0: the meter falls silent.
  await a.$eval('input[aria-label="Input volume"]', (el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '0');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await a.waitForTimeout(500);
  const silent = await a.evaluate(async () => {
    let max = 0;
    for (let i = 0; i < 20; i++) {
      max = Math.max(max, Number(document.querySelector('.mic-test-meter').getAttribute('aria-valuenow')));
      await new Promise((r) => setTimeout(r, 50));
    }
    return max;
  });
  if (silent > 0) throw new Error(`meter still moves at input volume 0 (${silent})`);
  console.log('input volume 0: the meter is still');
  await a.click('button:has-text("Stop testing")');
  await a.click('button:has-text("Reset voice settings")');

  // A guild with a voice channel; both join.
  await goTo(a, '/dm');
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Voice Settings');
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
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  const voiceUrl = new URL(b.url()).pathname;
  console.log('both in voice; bob hears alice');

  // Alice, still in the call, turns her input volume to 0, then back.
  await openVoiceSettings(a);
  await a.waitForSelector('.voice-bar-status.connected');
  const setRange = (label, value) => a.$eval(`input[aria-label="${label}"]`, (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await setRange('Input volume', '0');
  await b.waitForSelector(`${tile(alice.name)}:not(.speaking)`, { timeout: 15000 });
  // Stays quiet (not just a pause in the "speech").
  await b.waitForTimeout(3000);
  if (await b.$(`${tile(alice.name)}.speaking`)) throw new Error('alice still heard at input volume 0');
  console.log('alice at input volume 0: bob hears nothing');
  await setRange('Input volume', '100');
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  console.log('back at 100%: heard again');

  // Another microphone, and each noise suppression: captured again, still heard.
  const otherMic = inputs.find(([value]) => value)?.[0];
  await a.selectOption('select[aria-label="Input device"]', otherMic);
  await a.waitForTimeout(1500);
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  const micLabel = await a.evaluate(() => [...document.querySelectorAll('select[aria-label="Input device"] option')].find((o) => o.selected)?.textContent);
  console.log(`alice switched to "${micLabel}": still heard`);
  for (const mode of ['strong', 'off', 'standard']) {
    await a.check(`input[name="noise-suppression"][value="${mode}"]`);
    // Strong loads DeepFilterNet (17 MB) the first time.
    await a.waitForTimeout(mode === 'strong' ? 4000 : 1500);
    await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
    if (await a.$('.voice-bar .voice-bar-error, .voice-mic-error')) console.log('note: a mic error is shown');
    console.log(`noise suppression ${mode}: still heard`);
  }
  if (await a.$('.voice-bar-status.connected') === null) throw new Error('alice left voice');
  await shot(a, '02-alice-settings-in-call');

  // Bob: output volume and speakers apply to the voices playing.
  await openVoiceSettings(b);
  const bobOutputs = await b.$$eval('select[aria-label="Output device"] option', (o) => o.map((x) => x.value));
  await b.$eval('input[aria-label="Output volume"]', (el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '40');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const speaker = bobOutputs.find((v) => v) ?? null;
  if (speaker) await b.selectOption('select[aria-label="Output device"]', speaker);
  await b.waitForTimeout(1000);
  const playing = await voiceOutputs(b);
  console.log('bob\'s voice audio:', JSON.stringify(playing), 'chosen speaker:', speaker);
  if (!playing.length || playing.some((p) => Math.abs(p.volume - 0.4) > 0.01)) throw new Error('output volume not applied');
  if (speaker && playing.some((p) => p.sinkId !== speaker)) throw new Error('speakers not applied');
  // A new voice (Alice rejoins) gets them too.
  await goTo(a, voiceUrl);
  await a.click('.voice-bar button[aria-label="Disconnect"]').catch(() => {});
  await a.waitForSelector('.voice-bar-status.connected', { state: 'detached', timeout: 10000 }).catch(() => {});
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.waitForFunction(() => document.querySelectorAll('[data-voice-audio] audio').length > 0, null, { timeout: 15000 });
  await b.waitForTimeout(1000);
  const elements = await b.$$eval('[data-voice-audio] audio', (els) => els.length);
  if (elements !== 1) throw new Error(`${elements} audio elements for one voice (old ones left behind)`);
  // The old voice's gain stays in the list (disconnected): the newest is the one playing.
  const again = (await voiceOutputs(b)).slice(-1);
  console.log('after alice rejoined:', JSON.stringify(again));
  if (again.some((p) => Math.abs(p.volume - 0.4) > 0.01 || (speaker && p.sinkId !== speaker))) throw new Error('new voice missed the settings');
  await shot(b, '03-bob-output-settings');

  // Phone: no sideways scrolling.
  const phone = await signUp(browser, 'phone', { ...devices['Pixel 7'] });
  await phone.page.goto(`${BASE}/settings#voice-video`);
  await phone.page.waitForSelector('.voice-settings');
  await phone.page.waitForTimeout(500);
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('Voice settings scroll sideways on a phone');
  await phone.page.$eval('.voice-settings', (el) => el.scrollIntoView());
  await shot(phone.page, '04-phone');
  console.log('phone: fits');
  console.log('PASS');
} finally {
  await browser.close();
}
