// Push to talk (voice/pushToTalk.js). Settings → Voice & video: choosing Push to talk starts
// recording a key (none set yet), the key shown, Input sensitivity says the key decides, the
// release delay. Then the real microphone chain (built as a call builds it, on the fake mic)
// measured: silent until the key is held, sending while it is, still sending through the
// release delay, silent after it; the page losing focus lets go; the back mouse button as the
// key. With voice (serve.mjs's LiveKit), what Bob receives from Alice: silence until she holds
// the key, her voice while she does; the hold button in the voice bar does the same; her own
// ring stays out while she doesn't talk; a phone shows the hold button in the channel view.
//   node e2e/serve.mjs &   then   node e2e/pushtotalk.mjs [screenshot dir]
import { launchChrome, signUp, fakeMicArgs, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const SILENT_DB = -90;
const TALKING_DB = -50;

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log('ok:', message);
}

// The loudest moment over `ms` of what `window.pttLevel()` measures, in dB.
async function loudest(page, ms = 700) {
  return page.evaluate(async (wait) => {
    let max = -Infinity;
    const end = performance.now() + wait;
    while (performance.now() < end) {
      max = Math.max(max, window.pttLevel());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return max;
  }, ms);
}

// A meter on an audio track's samples, as `window.pttLevel()` (dB).
const METER = `(track) => {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  window.pttLevel = () => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    return 20 * Math.log10(peak || 1e-9);
  };
}`;

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  a.on('console', (m) => {
    if (m.type() === 'error') console.log('[alice error]', m.text().slice(0, 200));
  });

  // Every module the page loads stays listed (see below; the default list holds 250).
  await a.context().addInitScript(() => performance.setResourceTimingBufferSize(10000));

  // Settings: Push to talk, recording its key straight away.
  await a.goto(`${BASE}/settings/voice-video`);
  await a.waitForSelector('#settings-input-mode');
  await a.click('label:has-text("Push to talk") input[type="radio"]');
  await a.waitForSelector('.push-to-talk-key-button.recording');
  check(await a.isVisible('text=Escape cancels, Backspace clears it'), 'choosing push to talk records a key at once');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.push-to-talk-key-button:has-text("Not set")');
  check(true, 'Escape cancels recording');
  await a.click('.push-to-talk-key-button');
  await a.keyboard.press('Backquote');
  await a.waitForSelector('.push-to-talk-key-button:has-text("`")');
  check(true, 'the key pressed is shown');
  check(await a.isVisible('text=your voice is sent while you hold the key'), 'Input sensitivity says the key decides');
  check(await a.locator('label:has-text("Sends your voice only while you talk") input[type="checkbox"]').count() === 0, 'no sensitivity controls with push to talk');
  await a.evaluate(() => document.querySelector('#settings-input-mode').scrollIntoView());
  await shot(a, '01-settings');

  // The microphone chain a call uses, on the fake mic, with the app's own modules.
  // (The very modules the page loaded: after an edit Vite serves a file as ?t=…, and importing
  // it by its plain path would make a second copy, with its own state.)
  await a.evaluate(async (meter) => {
    const loaded = (path) => performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => new URL(name).pathname === path) ?? path;
    const { createVoiceChain } = await import(loaded('/src/voice/voiceChain.js'));
    const { inputGainStage, setAudioSettings } = await import(loaded('/src/voice/audioSettings.js'));
    const { VOICE_SAMPLE_RATE, voiceProcessingStage } = await import(loaded('/src/voice/noise/noiseStages.js'));
    const { pushToTalkStage } = await import(loaded('/src/voice/pushToTalk.js'));
    setAudioSettings({ pushToTalkDelay: 600 });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    const chain = createVoiceChain([inputGainStage, voiceProcessingStage, pushToTalkStage], { sampleRate: VOICE_SAMPLE_RATE });
    await chain.init({ track: stream.getAudioTracks()[0], audioContext: context });
    // eslint-disable-next-line no-eval
    eval(meter)(chain.processedTrack);
  }, METER);
  await a.click('body', { position: { x: 5, y: 5 } }); // focus in the page, not a box
  await a.waitForTimeout(1500); // noise suppression loading
  const idle = await loudest(a);
  check(idle < SILENT_DB, `nothing sent before the key is held (${idle.toFixed(1)} dB)`);
  await a.keyboard.down('Backquote');
  const held = await loudest(a);
  check(held > TALKING_DB, `the voice is sent while it's held (${held.toFixed(1)} dB)`);
  await a.keyboard.up('Backquote');
  const inDelay = await loudest(a, 400);
  check(inDelay > TALKING_DB, `still sent during the 600 ms release delay (${inDelay.toFixed(1)} dB)`);
  await a.waitForTimeout(500);
  const after = await loudest(a);
  check(after < SILENT_DB, `silent after the delay (${after.toFixed(1)} dB)`);

  await a.keyboard.down('Backquote');
  await a.evaluate(() => window.dispatchEvent(new Event('blur')));
  await a.waitForTimeout(700);
  const blurred = await loudest(a);
  check(blurred < SILENT_DB, `the page losing focus lets go (${blurred.toFixed(1)} dB)`);
  await a.keyboard.up('Backquote');

  // The back mouse button as the key (CDP: Playwright's mouse has no side buttons).
  await a.click('.push-to-talk-key-button');
  const cdp = await a.context().newCDPSession(a);
  const side = (type) => cdp.send('Input.dispatchMouseEvent', { type, x: 300, y: 300, button: 'back', buttons: type === 'mousePressed' ? 8 : 0, clickCount: 1 });
  await side('mousePressed');
  await side('mouseReleased');
  await a.waitForSelector('.push-to-talk-key-button:has-text("Mouse back button")');
  check(true, 'a mouse side button can be the key');
  const url = a.url();
  await side('mousePressed');
  const sideHeld = await loudest(a);
  await side('mouseReleased');
  check(sideHeld > TALKING_DB, `holding the back button sends (${sideHeld.toFixed(1)} dB)`);
  check(a.url() === url, 'the back button didn\'t go back');
  await a.click('.push-to-talk-key-button');
  await a.keyboard.press('Backquote');
  await a.waitForSelector('.push-to-talk-key-button:has-text("`")');

  // A phone's Settings: the same, fitting.
  const phone = await signUp(browser, 'carol', devices['Pixel 7']);
  const p = phone.page;
  await p.goto(`${BASE}/settings/voice-video`);
  await p.click('label:has-text("Push to talk") input[type="radio"]');
  await p.keyboard.press('Escape');
  await p.evaluate(() => document.querySelector('#settings-input-mode').scrollIntoView());
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'the phone\'s Settings fit its width');
  await shot(p, '02-phone-settings');

  const voiceEnabled = await a.evaluate(async () => (await (await fetch('/api/config')).json()).voiceEnabled);
  if (!voiceEnabled) {
    console.log('skipped: voice (no LiveKit; serve.mjs needs LIVEKIT_BIN)');
  } else {
    const bob = await signUp(browser, 'bob');
    const b = bob.page;
    await a.click('button[aria-label="Add a guild"]');
    await a.fill('#new-guild-name', 'Push To Talk');
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
    await b.click('.user-panel button[aria-label="Mute"]');
    await b.waitForFunction(() => document.querySelector('[data-voice-audio] audio')?.srcObject, null, { timeout: 15000 });
    await b.evaluate((meter) => {
      // eslint-disable-next-line no-eval
      eval(meter)(document.querySelector('[data-voice-audio] audio').srcObject.getAudioTracks()[0]);
    }, METER);

    await b.waitForTimeout(1500);
    const heardIdle = await loudest(b, 1500);
    check(heardIdle < SILENT_DB, `Bob hears nothing while Alice doesn't hold the key (${heardIdle.toFixed(1)} dB)`);
    check(await a.isHidden(`.voice-tile:has-text("${alice.name}").speaking`), 'her own ring stays out');
    await a.keyboard.down('Backquote');
    const heardHeld = await loudest(b, 1500);
    check(heardHeld > TALKING_DB, `Bob hears her while she holds it (${heardHeld.toFixed(1)} dB)`);
    await a.waitForSelector(`.voice-tile:has-text("${alice.name}").speaking`, { timeout: 5000 });
    check(true, 'her own ring lights while she talks');
    await shot(a, '03-talking');
    await a.keyboard.up('Backquote');
    await a.waitForTimeout(1200);
    check(await loudest(b, 1000) < SILENT_DB, 'silent again once she lets go');

    // The voice bar's hold button.
    const button = a.locator('.voice-bar-ptt');
    check(await button.isVisible(), 'the voice bar has a hold button');
    const box = await button.boundingBox();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await a.mouse.down();
    await a.waitForSelector('.voice-bar-ptt.active');
    const heardButton = await loudest(b, 1500);
    await shot(a, '04-hold-button');
    await a.mouse.up();
    check(heardButton > TALKING_DB, `holding the voice bar's button sends (${heardButton.toFixed(1)} dB)`);

    // Muted, the button is greyed out and nothing is sent.
    await a.click('.user-panel button[aria-label="Mute"]');
    check(await button.isDisabled(), 'the hold button is greyed out while muted');
    await a.keyboard.down('Backquote');
    const heardMuted = await loudest(b, 1500);
    await a.keyboard.up('Backquote');
    check(heardMuted < SILENT_DB, `muted wins over the key (${heardMuted.toFixed(1)} dB)`);
    await a.click('.user-panel button[aria-label="Unmute"]');

    // A phone: the hold button in the channel view.
    await p.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
    await p.click('button:has-text("Accept invite")');
    await p.goto(BASE + loungeUrl);
    await p.click('.voice-view-join');
    await p.waitForSelector('.voice-view-controls .push-to-talk-button', { timeout: 20000 });
    check(true, 'a phone shows the hold button in the channel view');
    await shot(p, '05-phone');
  }
  console.log('OK');
} finally {
  await browser.close();
}
