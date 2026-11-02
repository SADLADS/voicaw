// A screen share's sound in the real desktop app on Linux (electron/streamSound.js), under Xvfb
// with this host's PipeWire: Bob's app (its speakers and microphone throwaway null sinks, so
// nothing reaches the host's own devices) shares its screen with "Share sound" ticked while
// another program plays a 440 Hz tone. Alice (Chrome, talking) watches it and hears the tone in
// the stream; Bob's app plays her voice, which is never linked into the stream (no voices sent
// back). The virtual microphone isn't in Bob's Settings → Voice & Video, a program starting during
// the share is linked, and stopping the share (then quitting) removes it.
//   node e2e/serve.mjs &   (the client built for the desktop app against it first: README,
//   "The real desktop app")   then   node e2e/streamsound.mjs [screenshot dir]
// Needs PipeWire running for this user (pw-dump, pw-link, pw-cli, pactl, pacat).
// E2E_SOUND_DISPLAY (:79) and E2E_SOUND_CDP_PORT (9379) if those are taken.
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'fs';
import { spawn, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { BASE, launchChrome, signUp, makeFriends, fakeMicArgs } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
async function until(test, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(test).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

if (!existsSync(join(root, 'build', 'index.html'))) {
  console.log('Build the client for the desktop app first (see the top of this file).');
  process.exit(1);
}

// pw-dump can print more than one list (changes while it dumped): read as the app does.
const { parseDump } = createRequire(import.meta.url)('../electron/streamSound.js');
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const graph = () => parseDump(execFileSync('pw-dump', { maxBuffer: 64 << 20 }).toString());
const ourNodes = (objects) => objects.filter((o) => String(o.info?.props?.['node.name'] ?? '').startsWith('voicaw-stream-sound-'));
const propsOf = (objects, id) => objects.find((o) => o.id === id)?.info?.props ?? {};
// The programs linked into the stream's microphone, as { name, pid }.
function linkedPrograms() {
  const objects = graph();
  const node = ourNodes(objects)[0];
  if (!node) return null;
  return objects.filter((o) => o.type === 'PipeWire:Interface:Link' && o.info['input-node-id'] === node.id)
    .map((l) => propsOf(objects, l.info['output-node-id']))
    .map((p) => ({ name: p['application.name'], pid: Number(p['application.process.id']) }));
}

// Throwaway devices: Bob's app's speakers (where the tone plays too) and a silent microphone.
const SPEAKERS = 'voicaw_e2e_speakers';
const SILENCE = 'voicaw_e2e_silence';
const modules = [SPEAKERS, SILENCE].map((name) => execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${name}`]).toString().trim());

// Another program playing a 440 Hz tone (to the throwaway speakers).
const players = [];
function playTone(name, frequency = 440) {
  const p = spawn('pacat', [`--device=${SPEAKERS}`, '--format=s16le', '--channels=2', '--rate=48000', `--client-name=${name}`], { stdio: ['pipe', 'ignore', 'ignore'] });
  let t = 0;
  const chunk = () => {
    const frames = 2400;
    const buf = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++, t++) {
      const v = Math.round(Math.sin((2 * Math.PI * frequency * t) / 48000) * 12000);
      buf.writeInt16LE(v, i * 4);
      buf.writeInt16LE(v, i * 4 + 2);
    }
    return buf;
  };
  p.stdin.on('error', () => {});
  const timer = setInterval(() => p.stdin.write(chunk()), 50);
  const player = { p, timer, stop: () => { clearInterval(timer); p.kill(); } };
  players.push(player);
  return player;
}

// Alice's taps (as streamvolume.mjs): an analyser on every voice and stream she plays out loud
// (her own microphone's chain, which never reaches the speakers, isn't one).
const tapOutput = () => {
  window.__taps = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function tapped(target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (this instanceof MediaStreamAudioSourceNode && target instanceof GainNode) {
      const input = this.context.createAnalyser();
      input.fftSize = 4096;
      connect.call(this, input);
      target.__input = input;
    } else if (this.__input && target instanceof GainNode) {
      target.__input = this.__input;
    }
    if (this.__input && target instanceof AudioDestinationNode && !this.__tapped) {
      this.__tapped = true;
      window.__taps.push(this.__input);
    }
    return result;
  };
};
// The loudest tap's level and its strongest frequency, over `ms`.
const heard = (page, ms = 1500) => page.evaluate(async (ms) => {
  const end = performance.now() + ms;
  let best = { rms: 0, peakHz: 0 };
  while (performance.now() < end) {
    for (const analyser of window.__taps ?? []) {
      if (analyser.context.state === 'closed') continue;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
      if (rms <= best.rms) continue;
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 0;
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      best = { rms, peakHz: Math.round((peak * analyser.context.sampleRate) / analyser.fftSize) };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return best;
}, ms);

const display = process.env.E2E_SOUND_DISPLAY || ':79';
const cdpPort = process.env.E2E_SOUND_CDP_PORT || '9379';
const scratch = mkdtempSync(join(tmpdir(), 'voicaw-streamsound-'));
mkdirSync(join(scratch, 'run'), { recursive: true, mode: 0o700 });
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
let electron = null;
// Alice talks (Chrome's fake microphone), so Bob's app plays a voice the stream must not carry.
// Her Chrome plays nothing out loud: as another program on this host, its sound (Bob's stream)
// would be linked straight back into the stream.
const browser = await launchChrome({ args: [...fakeMicArgs({ phrases: true }), '--disable-audio-output'] });
try {
  const alice = await signUp(browser, 'alice');
  const bobWeb = await signUp(browser, 'bob');
  await makeFriends(alice, bobWeb);
  const a = alice.page;
  await a.context().addInitScript(tapOutput);

  const { guildId, channelId, code } = await a.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const guild = await (await fetch('/api/guilds', { method: 'POST', headers, body: JSON.stringify({ name: 'Streams' }) })).json();
    const channel = await (await fetch(`/api/guilds/${guild.id}/channels`, { method: 'POST', headers, body: JSON.stringify({ name: 'lounge', type: 'voice' }) })).json();
    const invite = await (await fetch(`/api/guilds/${guild.id}/invites`, { method: 'POST', headers })).json();
    return { guildId: guild.id, channelId: channel.id, code: invite.code };
  });
  await bobWeb.page.evaluate(async (c) => {
    await fetch(`/api/invites/${c}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  }, code);
  await bobWeb.page.context().close();

  // Bob's desktop app, on this host's PipeWire and its throwaway devices (no fake media flags:
  // they'd take over the screen capture and the devices).
  electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [join(root, 'electron/main.js'), '--no-sandbox', `--remote-debugging-port=${cdpPort}`, '--autoplay-policy=no-user-gesture-required'],
    {
      env: {
        ...process.env,
        DISPLAY: display,
        HOME: join(scratch, 'home'),
        XDG_CONFIG_HOME: join(scratch, 'config'),
        XDG_RUNTIME_DIR: join(scratch, 'run'),
        PIPEWIRE_RUNTIME_DIR: runtime,
        PULSE_SERVER: `unix:${runtime}/pulse/native`,
        PULSE_SINK: SPEAKERS,
        PULSE_SOURCE: `${SILENCE}.monitor`,
      },
      stdio: 'ignore',
    });
  let app = null;
  const pages = () => app.contexts().flatMap((c) => c.pages());
  await until(async () => {
    app ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    return pages().some((p) => p.url().startsWith('voicaw://app/'));
  }, 30000);
  const bob = pages().find((p) => p.url().startsWith('voicaw://app/'));
  bob.on('pageerror', (e) => console.log('[bob app] page error:', e.message));
  bob.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('[bob app]', m.text().slice(0, 300)); });
  await bob.waitForSelector('input[placeholder="Username"]', { timeout: 30000 });
  await bob.fill('input[placeholder="Username"]', bobWeb.name);
  await bob.fill('input[placeholder="Password"]', bobWeb.password);
  await bob.press('input[placeholder="Password"]', 'Enter');
  await bob.waitForSelector('#dm-main', { timeout: 30000 });

  await a.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await bob.goto(`voicaw://app/guild/${guildId}/${channelId}`);
  await bob.click('.voice-view-join');
  await bob.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  if (await bob.$('.user-panel button[aria-label="Mute"]')) await bob.click('.user-panel button[aria-label="Mute"]');

  const tone = playTone('Tone player');
  await sleep(1000);

  // Bob goes live with sound.
  await bob.click('.voice-bar button[aria-label="Share your screen"]');
  await bob.waitForSelector('.screen-picker [role="option"]', { timeout: 15000 });
  const sound = bob.locator('.screen-picker label:has-text("Share sound") input');
  check(await sound.count() === 1 && await sound.isChecked(), 'the picker offers Share sound, ticked');
  await shot(bob, '01-picker');
  await bob.locator('.screen-picker [role="option"]').first().click();
  await bob.click('.screen-picker button:has-text("Go Live")');
  await bob.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 15000 });

  check(await until(() => (linkedPrograms() ?? []).some((p) => p.name === 'Tone player'), 10000), 'the tone player is linked into the stream\'s microphone');
  const electronPids = new Set(execFileSync('pgrep', ['-f', 'electron/dist/electron']).toString().split('\n').filter(Boolean).map(Number));
  const linked = linkedPrograms() ?? [];
  console.log('linked:', JSON.stringify(linked));
  const objects = graph();
  const ownPlayback = objects.filter((o) => o.info?.props?.['media.class'] === 'Stream/Output/Audio' && electronPids.has(Number(o.info.props['application.process.id'])));
  check(ownPlayback.length > 0, `Bob's app plays sound itself (${ownPlayback.length} stream(s))`);
  check(!linked.some((p) => electronPids.has(p.pid)), 'none of the app\'s own sound is linked');

  const labels = await bob.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label));
  console.log('Bob\'s app sees microphones:', JSON.stringify(labels));
  check(labels.some((l) => l.startsWith('Voicaw stream sound')), 'the browser lists the stream sound as a microphone');
  const published = await bob.evaluate(() => [...document.querySelectorAll('.voice-tile')].length);
  check(published > 0, 'tiles shown');

  // Alice watches: the stream carries the tone.
  await a.waitForSelector(`.voice-tile:has-text("${bobWeb.name}") .voice-tile-watch`, { timeout: 15000 });
  await a.click(`.voice-tile:has-text("${bobWeb.name}") .voice-tile-watch`);
  await a.waitForFunction(() => {
    const v = document.querySelector('.stream-view video');
    return v && v.videoWidth > 0 && v.currentTime > 0.3;
  }, null, { timeout: 20000 });
  let got = { rms: 0 };
  await until(async () => {
    got = await heard(a);
    return got.rms > 0.02 && Math.abs(got.peakHz - 440) < 30;
  }, 20000);
  console.log('Alice hears:', JSON.stringify(got));
  check(got.rms > 0.02 && Math.abs(got.peakHz - 440) < 30, `Alice hears the 440 Hz tone in Bob's stream (${got.peakHz} Hz)`);
  await shot(a, '02-alice-watching');

  // The tone stops: Bob's app still plays Alice's voice, which mustn't come back to her.
  tone.stop();
  await sleep(1500);
  const quiet = await heard(a, 3000);
  console.log('after the tone:', JSON.stringify(quiet));
  check(quiet.rms < 0.01, 'with the tone gone the stream is silent (Alice\'s own voice isn\'t sent back)');

  // A program that starts during the share is linked too.
  playTone('Late player', 660);
  check(await until(() => (linkedPrograms() ?? []).some((p) => p.name === 'Late player'), 8000), 'a program starting during the share is linked');
  let late = { rms: 0 };
  await until(async () => {
    late = await heard(a);
    return Math.abs(late.peakHz - 660) < 30;
  }, 10000);
  check(Math.abs(late.peakHz - 660) < 30, `Alice hears it (${late.peakHz} Hz)`);

  // Not a microphone to choose in Settings (opened inside the page: a reload would leave voice).
  const navigate = (path) => bob.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await navigate('/settings/voice-video');
  await bob.waitForSelector('select[aria-label="Input device"]', { timeout: 10000 });
  await sleep(500);
  const options = await bob.$$eval('select[aria-label="Input device"] option', (os) => os.map((o) => o.textContent));
  console.log('Settings microphones:', JSON.stringify(options));
  check(options.length > 1 && !options.some((o) => o.includes('Voicaw stream sound')), 'Settings → Voice & Video doesn\'t list it');
  await shot(bob, '03-settings');
  await navigate(`/guild/${guildId}/${channelId}`);

  // Stopping the share removes the microphone.
  await bob.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  check(await until(() => ourNodes(graph()).length === 0, 8000), 'stopping the share removes the stream\'s microphone');

  const goLive = async () => {
    await bob.click('.voice-bar button[aria-label="Share your screen"]');
    await bob.waitForSelector('.screen-picker [role="option"]', { timeout: 15000 });
    await bob.locator('.screen-picker [role="option"]').first().click();
    await bob.click('.screen-picker button:has-text("Go Live")');
  };
  // Again, then the page reloading removes it.
  await goLive();
  check(await until(() => ourNodes(graph()).length === 1, 10000), 'sharing again makes it again');
  await bob.reload();
  check(await until(() => ourNodes(graph()).length === 0, 8000), 'the page reloading removes it');

  // Once more, then quitting the app removes it too.
  await bob.waitForSelector('.voice-view-join', { timeout: 30000 });
  await bob.click('.voice-view-join');
  await bob.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await goLive();
  check(await until(() => ourNodes(graph()).length === 1, 10000), 'and again');
  const electronProcess = electron;
  await app.close().catch(() => {});
  electronProcess.kill('SIGTERM');
  await until(() => electronProcess.exitCode !== null || electronProcess.signalCode !== null, 10000);
  electron = null;
  check(await until(() => ourNodes(graph()).length === 0, 5000), 'quitting the app removes it');
} finally {
  for (const p of players) p.stop();
  if (electron) electron.kill('SIGKILL');
  await browser.close().catch(() => {});
  xvfb.kill();
  for (const id of modules) execFileSync('pactl', ['unload-module', id]);
  for (const node of ourNodes(graph())) execFileSync('pw-cli', ['destroy', String(node.id)]);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all passed');
process.exit(failures ? 1 : 0);
