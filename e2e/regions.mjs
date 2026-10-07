// Voice regions and voice channel settings in real browsers. This script starts a second LiveKit
// (E2E_LIVEKIT2_PORT, default API + 11, with media on the next two ports) to be "Frankfurt":
// an admin adds it in Settings → Admin → Voice regions; makes a voice channel at 128 kbps for
// two people (its microphones are measured going out at that, not LiveKit's 48 kbps); a third
// person (phone) finds it full ("02/02"); the bitrate changes live; the channel moves to
// Frankfurt and both apps follow, still hearing each other (asks both LiveKits who's in);
// Frankfurt made the default, then removed: the channel goes back to the main server.
//   node e2e/serve.mjs &   then   node e2e/regions.mjs [screenshot dir]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { RoomServiceClient } from 'livekit-server-sdk';
import { launchChrome, signUp, devices, fakeMicArgs, livekitInfoPath, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const apiPort = Number(process.env.E2E_API_PORT || 3099);
const port = Number(process.env.E2E_LIVEKIT2_PORT || apiPort + 11);
if ([port, port + 1, port + 2].some((p) => [3002, 5173, 7880, 7881, 7882].includes(p))) throw new Error('pick other ports');

// The second LiveKit, its webhooks to the same API, signed with its own key.
const frankfurt = { key: `e2e-frankfurt-${randomBytes(3).toString('hex')}`, secret: randomBytes(24).toString('hex'), url: `ws://localhost:${port}` };
const config = join(mkdtempSync(join(tmpdir(), 'voicaw-e2e-livekit2-')), 'livekit.yaml');
writeFileSync(config, [
  `port: ${port}`,
  'bind_addresses: ["127.0.0.1"]',
  'rtc:',
  `  tcp_port: ${port + 1}`,
  `  udp_port: ${port + 2}`,
  '  use_external_ip: false',
  '  node_ip: 127.0.0.1',
  '  enable_loopback_candidate: true',
  '  interfaces: { includes: [lo] }',
  `keys: { ${frankfurt.key}: ${frankfurt.secret} }`,
  'webhook:',
  `  api_key: ${frankfurt.key}`,
  `  urls: ["http://127.0.0.1:${apiPort}/api/livekit/webhook"]`,
  'logging: { level: warn }',
].join('\n'), { mode: 0o600 });
const livekit2 = spawn(process.env.LIVEKIT_BIN || join(homedir(), 'livekit', 'livekit-server'), ['--config', config], { stdio: 'inherit' });

const main = JSON.parse(readFileSync(livekitInfoPath(), 'utf8'));
const servers = {
  main: new RoomServiceClient(main.url, main.key, main.secret),
  frankfurt: new RoomServiceClient(`http://127.0.0.1:${port}`, frankfurt.key, frankfurt.secret),
};
// Who each LiveKit has in the channel's room.
const inRoom = async (server, channelId) => {
  try {
    return (await servers[server].listParticipants(`channel-${channelId}`)).map((p) => p.name).sort();
  } catch {
    return [];
  }
};
async function waitForRoom(server, channelId, names) {
  const want = [...names].sort().join(',');
  for (let i = 0; i < 60; i++) {
    if ((await inRoom(server, channelId)).join(',') === want) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${server} has ${JSON.stringify(await inRoom(server, channelId))}, not ${want}`);
}

// The page's own microphone sender (every RTCPeerConnection is kept by an init script): its
// limit, and what it actually sent over `ms`.
const SAVE_PEER_CONNECTIONS = () => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Original(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
};
async function micSending(page, ms = 4000) {
  return page.evaluate(async (wait) => {
    const senders = () => window.__pcs.filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders()).filter((s) => s.track?.kind === 'audio');
    const sent = async () => {
      let bytes = 0;
      for (const s of senders()) {
        for (const r of (await s.getStats()).values()) if (r.type === 'outbound-rtp') bytes += r.bytesSent;
      }
      return bytes;
    };
    const before = await sent();
    await new Promise((r) => setTimeout(r, wait));
    const after = await sent();
    const limits = senders().map((s) => s.getParameters().encodings?.[0]?.maxBitrate ?? null);
    return { limits, kbps: Math.round(((after - before) * 8) / wait) };
  }, ms);
}

const tile = (name) => `.voice-tile:has-text("${name}")`;

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const admin = await signUp(browser, 'admin');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = admin.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['admin', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} error]`, m.text().slice(0, 200));
    });
  }
  await a.context().addInitScript(SAVE_PEER_CONNECTIONS);
  await b.context().addInitScript(SAVE_PEER_CONNECTIONS);

  // Settings → Admin → Voice regions: the main one (.env), and Frankfurt added (any left by an
  // earlier run removed first).
  await a.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
    const { voiceRegions } = await (await fetch('/api/admin', { headers })).json();
    for (const r of voiceRegions.filter((v) => !v.builtin)) await fetch(`/api/admin/voice-regions/${r.id}`, { method: 'DELETE', headers });
  });
  await a.goto(`${BASE}/settings`);
  await a.waitForSelector('.voice-regions-admin');
  await a.waitForSelector('.voice-region:has-text("Main") .voice-region-badge:has-text("Default")');
  await a.click('button:has-text("Add a region")');
  // The flag from the emoji picker's Flags (only those: no smileys found).
  await a.click('button[aria-label="Choose a flag"]');
  await a.waitForSelector('.emoji-picker h6:has-text("Flags")');
  await a.fill('.emoji-picker-search', 'smile');
  await a.waitForSelector('.emoji-picker-empty');
  await a.fill('.emoji-picker-search', 'pirate');
  await a.waitForSelector('.emoji-picker button[aria-label="Pirate Flag"]');
  await shot(a, '00-flag-picker');
  await a.fill('.emoji-picker-search', 'germany');
  await a.click('.emoji-picker button[aria-label="Germany Flag"]');
  await a.waitForSelector('.emoji-picker', { state: 'detached' });
  await a.waitForSelector('button[aria-label="Change the flag"] img[alt="🇩🇪"]');
  await a.fill('#region-new-name', 'Frankfurt');
  await a.fill('#region-new-url', 'https://wrong.example.com');
  await a.fill('#region-new-apiKey', frankfurt.key);
  await a.fill('#region-new-apiSecret', frankfurt.secret);
  await a.click('.voice-region-form button:has-text("Add region")');
  await a.waitForSelector('.voice-regions-admin .error-msg:has-text("wss://")');
  console.log('a non-websocket address is refused');
  await a.fill('#region-new-url', frankfurt.url);
  await a.fill('#region-new-apiUrl', `http://127.0.0.1:${port}`);
  await a.click('.voice-region-form button:has-text("Add region")');
  await a.waitForSelector('.voice-region:has-text("Frankfurt")');
  const listed = await a.textContent('.voice-regions-admin');
  if (listed.includes(frankfurt.secret)) throw new Error('the secret is shown');
  if (!listed.includes(`…${frankfurt.secret.slice(-4)}`)) throw new Error('no secret hint');
  console.log('Frankfurt added; only the end of its secret is shown');
  await a.$eval('.voice-regions-admin', (el) => el.scrollIntoView());
  await shot(a, '01-admin-voice-regions');

  // A guild with a voice channel made at 128 kbps for two people.
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Regions');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.waitForSelector('#channel-region label:has-text("Frankfurt") img[alt="🇩🇪"]');
  const automatic = await a.textContent('#channel-region label:first-of-type');
  if (!automatic.includes('Main')) throw new Error(`Automatic says ${automatic}`);
  await a.$eval('#channel-bitrate', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '128');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await a.$eval('#channel-user-limit', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await a.waitForSelector('.voice-channel-settings :text("128 kbps")');
  await a.waitForSelector('.voice-channel-settings :text("2 people")');
  await shot(a, '02-create-voice-channel');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const channelId = Number(a.url().split('/').pop().split('?')[0]);

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = (await a.inputValue('#invite-link')).replace(/^https?:\/\/[^/]+/, BASE);
  await a.keyboard.press('Escape');
  for (const page of [b, c]) {
    await page.goto(link);
    await page.click('button:has-text("Accept invite")');
    await page.waitForSelector('#dm-input, .guild-channel-link');
  }

  // Both join: on the main server, sending at 128 kbps.
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.waitForSelector(`${tile(admin.name)}.speaking`, { timeout: 15000 });
  await waitForRoom('main', channelId, [admin.name, bob.name]);
  console.log('both in, on the main server; bob hears the admin');
  const sending = await micSending(a);
  console.log('admin sends:', JSON.stringify(sending));
  if (!sending.limits.includes(128000)) throw new Error('not limited to 128 kbps');
  // (RED, LiveKit's loss protection, sends each frame twice: about double the bitrate goes out.)
  if (sending.kbps <= 2 * 56) throw new Error(`only ${sending.kbps} kbps out (LiveKit's default is 48, twice that with RED)`);

  // Carol (phone) can't get in: the channel's page says so before she tries, and the server
  // refuses her when she does; the channel list shows 02/02.
  const guildId = Number(a.url().split('/guild/')[1].split('/')[0]);
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.waitForSelector('.voice-view-error:has-text("This voice channel is full.")', { timeout: 10000 });
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-error:has-text("This voice channel is full")', { timeout: 10000 });
  if ((await c.textContent('.voice-view-footer')).includes('Disconnect')) throw new Error('carol got in');
  console.log('carol: "This voice channel is full"');
  await shot(c, '03-phone-channel-full');
  const limit = await a.textContent('.guild-channel:has-text("lounge") .guild-channel-limit');
  if (limit !== '02/02') throw new Error(`channel list says ${limit}`);
  await shot(a, '04-channel-list-full');

  // The bitrate changes live: the sender's limit moves without a reconnect.
  await a.click(`.guild-channel:has-text("lounge") button[aria-label^="Edit"]`);
  await a.waitForSelector('#channel-bitrate');
  await shot(a, '05-edit-voice-channel');
  await a.$eval('#channel-bitrate', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '32');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await a.click('.vc-dialog button:has-text("Save")');
  await a.waitForSelector('#channel-bitrate', { state: 'detached' });
  await new Promise((r) => setTimeout(r, 1000));
  const lower = await micSending(a);
  console.log('after 32 kbps:', JSON.stringify(lower));
  if (!lower.limits.includes(32000)) throw new Error('limit not changed live');
  if (lower.kbps > sending.kbps / 2) throw new Error(`still ${lower.kbps} kbps out`);
  if ((await a.textContent('.voice-bar-status')).includes('Reconnecting')) throw new Error('reconnected for a bitrate change');

  // Moved to Frankfurt: both apps follow (the main server lets go of them), still hearing.
  await a.click(`.guild-channel:has-text("lounge") button[aria-label^="Edit"]`);
  await a.click('#channel-region label:has-text("Frankfurt")');
  await a.click('.vc-dialog button:has-text("Save")');
  await a.waitForSelector('#channel-region', { state: 'detached' });
  await waitForRoom('frankfurt', channelId, [admin.name, bob.name]);
  await waitForRoom('main', channelId, []);
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.waitForSelector(`${tile(admin.name)}.speaking`, { timeout: 15000 });
  console.log('moved to Frankfurt: both there, none left on the main server, bob still hears');
  const moved = await micSending(a);
  if (!moved.limits.includes(32000)) throw new Error(`bitrate lost in the move: ${JSON.stringify(moved)}`);
  await shot(b, '06-bob-in-frankfurt');

  // Frankfurt the default, then removed: the channel is back on Automatic, the main server.
  // (In a second tab: the first stays in the call.)
  const s = await a.context().newPage();
  await s.goto(`${BASE}/settings`);
  await s.waitForSelector('.voice-region:has-text("Frankfurt")');
  await s.click('.voice-region:has-text("Frankfurt") button:has-text("Make default")');
  await s.waitForSelector('.voice-region:has-text("Frankfurt") .voice-region-badge');
  await s.click('.voice-region:has-text("Frankfurt") button:has-text("Remove")');
  await s.click('.voice-region:has-text("Frankfurt") .btn-danger');
  await s.waitForSelector('.voice-region:has-text("Frankfurt")', { state: 'detached' });
  await s.waitForSelector('.voice-region:has-text("Main") .voice-region-badge:has-text("Default")');
  await waitForRoom('main', channelId, [bob.name, admin.name]);
  console.log('Frankfurt removed: both back on the main server');
  await s.close();

  // The channel's settings at a phone's width: the sliders fit.
  await a.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await a.click(`.guild-channel:has-text("lounge") button[aria-label^="Edit"]`);
  await a.waitForSelector('#channel-bitrate');
  if (await a.$('#channel-region')) throw new Error('region menu shown with one region');
  await a.setViewportSize({ width: 400, height: 860 });
  await new Promise((r) => setTimeout(r, 300));
  const overflow = await a.evaluate(() => {
    const dialog = document.querySelector('.voice-channel-settings');
    return dialog.scrollWidth > dialog.clientWidth + 1;
  });
  if (overflow) throw new Error('voice settings overflow at phone width');
  await shot(a, '07-edit-at-phone-width');
  console.log('OK');
} finally {
  await browser.close();
  livekit2.kill();
}
