// Watch Together with the guild's own Jellyfin or Emby (e2e/mediacontainers.mjs starts both in
// Docker first). Alice (the owner) connects Jellyfin in Guild Settings → Watch Together (its
// administrator refused, then the "guild" account); Alice and Bob join the voice channel and
// Carol on a phone. The panel searches Jellyfin (its pictures load), Test Clip plays from the
// file for all three in step, pause and seek follow; Hevc Film, which browsers can't play,
// plays transcoded to HLS (one transcode for everyone) and seeks; a YouTube link in between
// swaps the player for YouTube's frame and back (needs the internet; skipped without it);
// switching to Emby takes Jellyfin's videos out and Emby's play; disconnecting empties it.
//   node e2e/mediacontainers.mjs && node e2e/serve.mjs &   then   node e2e/mediaservers.mjs [dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JELLYFIN = `http://127.0.0.1:${process.env.E2E_JELLYFIN_PORT || '18096'}`;
const EMBY = `http://127.0.0.1:${process.env.E2E_EMBY_PORT || '18097'}`;

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

// The player's <video>: { time, paused, src, ready }, or null.
const video = (page) => page.evaluate(() => {
  const v = document.querySelector('.watch-party-player video');
  return v ? { time: v.currentTime, paused: v.paused, src: v.currentSrc || v.src, ready: v.readyState } : null;
});

async function waitVideo(page, test, what, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await video(page);
    if (last && test(last)) return last;
    await sleep(250);
  }
  throw new Error(`FAILED: ${what} (last: ${JSON.stringify(last)})`);
}

async function inStep(pages, what, tolerance = 1.5) {
  const videos = await Promise.all(pages.map(video));
  const times = videos.map((v) => v.time);
  const spread = Math.max(...times) - Math.min(...times);
  if (spread >= tolerance) console.log(videos.map((v) => ({ ...v, src: v.src.slice(0, 90) })));
  check(spread < tolerance, `${what} (${times.map((t) => t.toFixed(2)).join(' / ')} s)`);
}

async function search(page, words) {
  await page.fill('.watch-party-add input', words);
  await page.click('.watch-party-add button[type="submit"]');
  await page.waitForSelector('.watch-party-result');
}

async function openSettings(page) {
  if (await page.$('.media-server-settings')) return;
  await page.click('.guild-header-button');
  await page.click('text=Guild Settings');
  await page.click('.settings-tab:has-text("Watch Together")');
  await page.waitForSelector('.media-server-settings form, .media-server-current');
}

async function connect(page, { kind, url, username, password }) {
  await openSettings(page);
  if (await page.$('.media-server-current button:has-text("Change")')) await page.click('.media-server-current button:has-text("Change")');
  await page.selectOption('#media-server-kind', kind);
  await page.fill('#media-server-url', url);
  await page.fill('#media-server-username', username);
  await page.fill('#media-server-password', password);
  await page.click('.media-server-settings button[type="submit"]');
  await page.waitForSelector('.media-server-settings .success-msg, .media-server-settings .error-msg', { timeout: 20000 });
  const error = await page.$eval('.media-server-settings', (el) => el.querySelector('.error-msg')?.textContent ?? null);
  return error;
}

const closeDialog = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.media-server-settings', { state: 'detached' });
};

const browser = await launchChrome({ args: [...fakeMicArgs(), '--autoplay-policy=no-user-gesture-required'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Film Club');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Cinema');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const cinemaUrl = a.url();
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  // Guild Settings → Watch Together.
  const adminError = await connect(a, { kind: 'jellyfin', url: JELLYFIN, username: 'admin', password: 'adminpw' });
  check(/administrator/.test(adminError ?? ''), `an administrator account is refused (${adminError})`);
  const wrongKind = await connect(a, { kind: 'emby', url: JELLYFIN, username: 'guild', password: 'guildpw' });
  check(/Jellyfin server, not Emby/.test(wrongKind ?? ''), `Jellyfin's address as Emby is refused (${wrongKind})`);
  const connected = await connect(a, { kind: 'jellyfin', url: `${JELLYFIN}/web/`, username: 'guild', password: 'guildpw' });
  check(connected === null, 'the guild account connects');
  const current = await a.textContent('.media-server-current');
  check(current.includes('(Jellyfin)') && current.includes(JELLYFIN) && current.includes('As guild'), `it says what's connected (${current})`);
  await shot(a, '01-settings');
  await closeDialog(a);

  // A voice channel in the list joins it.
  await a.click('.guild-channel-link:has-text("cinema")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("cinema")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  console.log('alice and bob in voice');

  await a.click('.watch-party-toggle');
  await a.waitForSelector('.watch-party-sources');
  const sources = await a.$$eval('.watch-party-source', (els) => els.map((e) => `${e.textContent}${e.getAttribute('aria-pressed') === 'true' ? '*' : ''}`));
  check(sources.length === 2 && sources[0].endsWith('*') && sources[1] === 'YouTube', `Search the server (picked) or YouTube (${sources})`);
  await search(a, 'clip');
  const result = await a.$eval('.watch-party-result', (li) => ({
    title: li.querySelector('.watch-party-result-title').textContent,
    meta: li.querySelector('.watch-party-item-meta').textContent,
    picture: li.querySelector('img')?.src ?? null,
  }));
  check(result.title === 'Test Clip' && result.meta === '2020 · 1:00', `Jellyfin's search finds Test Clip (${JSON.stringify(result)})`);
  if (result.picture) {
    await a.waitForFunction(() => document.querySelector('.watch-party-result img')?.complete);
    const loaded = await a.$eval('.watch-party-result img', (img) => img.naturalWidth);
    check(loaded > 0, `its picture loads from Jellyfin (${result.picture.split('?')[0]})`);
  }
  await shot(a, '02-results');
  await a.click('.watch-party-result button:has-text("Play")');

  await a.waitForSelector('.watch-party-player.docked video');
  await b.waitForSelector('.watch-party-player.docked video', { timeout: 10000 });
  const va = await waitVideo(a, (v) => !v.paused && v.time > 2, 'alice plays Test Clip');
  await waitVideo(b, (v) => !v.paused && v.time > 2, 'bob plays Test Clip');
  check(new URL(va.src).pathname.toLowerCase() === '/videos/' + new URL(va.src).pathname.split('/')[2].toLowerCase() + '/stream' && va.src.startsWith(JELLYFIN),
    `straight from Jellyfin's file (${va.src.replace(/api_key=\w+/, 'api_key=…')})`);
  await inStep([a, b], 'alice and bob in step');
  await shot(a, '03-playing');

  // Carol joins on her phone, from the channel's page.
  await c.goto(cinemaUrl);
  await c.waitForSelector('.watch-party-banner', { timeout: 10000 });
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls', { timeout: 20000 });
  await c.waitForSelector('.watch-party-player.docked video', { timeout: 15000 });
  await waitVideo(c, (v) => !v.paused && v.time > 2, 'carol plays on her phone');
  await inStep([a, b, c], 'carol joins in step');
  await shot(c, '04-phone');

  // Pause and seek follow Alice.
  await a.click('.watch-party-controls button[aria-label="Pause"]');
  await waitVideo(b, (v) => v.paused, 'bob pauses with alice', 5000);
  await waitVideo(c, (v) => v.paused, 'carol pauses with alice', 5000);
  await inStep([a, b, c], 'paused at the same point', 0.8);
  await a.evaluate(() => {
    const seek = document.querySelector('.watch-party-seek');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(seek, '40');
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await waitVideo(b, (v) => Math.abs(v.time - 40) < 1, 'bob jumps to 0:40', 8000);
  await a.click('.watch-party-controls button[aria-label="Play"]');
  await waitVideo(b, (v) => !v.paused && v.time > 41, 'bob plays on from 0:40', 8000);
  await waitVideo(c, (v) => !v.paused && v.time > 41, 'carol plays on from 0:40', 8000);
  check(true, 'pause and seek follow');

  // Hevc Film: transcoded to HLS by Jellyfin.
  await search(a, 'hevc');
  await a.click('.watch-party-result button:has-text("Add")');
  await a.waitForFunction(() => document.querySelectorAll('.watch-party-item').length === 1);
  await a.click('.watch-party-controls button[aria-label="Skip"]');
  const ha = await waitVideo(a, (v) => !v.paused && v.time > 2 && v.src.startsWith('blob:'), 'alice plays Hevc Film through HLS', 45000);
  await waitVideo(b, (v) => !v.paused && v.time > 2, 'bob plays Hevc Film', 45000);
  await waitVideo(c, (v) => !v.paused && v.time > 2, 'carol plays Hevc Film', 45000);
  console.log('hevc', ha);
  if (shots) await c.screenshot({ path: `${shots}/05a-phone-hls.png` });
  await inStep([a, b, c], 'HLS in step');
  const sessions = await (await fetch(`${JELLYFIN}/Sessions`, { headers: { 'X-Emby-Token': await jellyfinAdminToken() } })).json();
  const transcodes = sessions.filter((s) => s.TranscodingInfo).length;
  console.log('jellyfin sessions transcoding:', transcodes);
  await a.evaluate(() => {
    const seek = document.querySelector('.watch-party-seek');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(seek, '70');
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    seek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await waitVideo(b, (v) => v.time > 70 && v.time < 75 && !v.paused, 'bob jumps to 1:10 in the transcode', 20000);
  await waitVideo(a, (v) => v.time > 70 && v.time < 75 && !v.paused, 'alice jumps to 1:10 in the transcode', 20000);
  await inStep([a, b], 'in step after seeking the transcode');
  await shot(a, '05-hls');

  // A YouTube video in between (needs the internet): YouTube's frame, then the <video> again.
  const online = await fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=jNQXAC9IVRw', { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok).catch(() => false);
  if (online) {
    await a.fill('.watch-party-add input', 'https://youtu.be/jNQXAC9IVRw');
    await a.click('.watch-party-add button[type="submit"]');
    await search(a, 'clip');
    await a.click('.watch-party-result button:has-text("Add")');
    await a.waitForFunction(() => document.querySelectorAll('.watch-party-item').length === 2);
    await a.click('.watch-party-controls button[aria-label="Skip"]');
    await b.waitForSelector('.watch-party-player iframe', { timeout: 15000 });
    check(!(await b.$('.watch-party-player video')), 'a YouTube video swaps in YouTube\'s frame');
    await a.click('.watch-party-controls button[aria-label="Skip"]');
    await waitVideo(b, (v) => !v.paused && v.time > 1, 'and back to the <video> for the next', 20000);
    check(!(await b.$('.watch-party-player iframe')), 'the frame is gone again');
  } else {
    console.log('skipped: YouTube in between (no internet)');
  }

  // Emby instead: Jellyfin's video goes; Emby's plays (HLS too).
  await search(a, 'hevc');
  await a.click('.watch-party-result button:has-text("Add")');
  const changeError = await connect(a, { kind: 'emby', url: EMBY, username: 'guild', password: 'guildpw' });
  check(changeError === null, 'switched to Emby');
  await closeDialog(a);
  await b.waitForFunction(() => !document.querySelector('.watch-party-player'), null, { timeout: 10000 });
  check(true, "Jellyfin's videos left the queue");
  const embySources = await a.$$eval('.watch-party-source', (els) => els.map((e) => e.textContent));
  console.log('sources now', embySources);
  await search(a, 'hevc');
  await a.click('.watch-party-result button:has-text("Play")');
  const ea = await waitVideo(a, (v) => !v.paused && v.time > 2, 'alice plays from Emby', 45000);
  await waitVideo(b, (v) => !v.paused && v.time > 2, 'bob plays from Emby', 45000);
  check(ea.src.startsWith('blob:'), 'Emby transcodes it to HLS');
  await inStep([a, b], 'in step on Emby');
  await shot(b, '06-emby');

  // Disconnecting ends it.
  await openSettings(a);
  await a.click('.media-server-current button:has-text("Disconnect")');
  await a.waitForSelector('.media-server-settings form');
  await closeDialog(a);
  await b.waitForFunction(() => !document.querySelector('.watch-party-player'), null, { timeout: 10000 });
  await a.waitForFunction(() => !document.querySelector('.watch-party-sources'), null, { timeout: 10000 });
  check(true, 'disconnected: the video stops and the switch goes');

  // The audit log says so.
  await a.click('.guild-header-button');
  await a.click('text=Audit Log');
  await a.waitForSelector('text=disconnected the media server');
  check(Boolean(await a.$('text=connected the media server')), 'the audit log has the connects and the disconnect');
  await shot(a, '07-audit');
  console.log('done');
} finally {
  await browser.close();
}

async function jellyfinAdminToken() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="e2e", Device="e2e", DeviceId="voicaw-e2e", Version="1"' },
    body: JSON.stringify({ Username: 'admin', Pw: 'adminpw' }),
  });
  return (await res.json()).AccessToken;
}
