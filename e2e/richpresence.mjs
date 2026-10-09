// Rich Presence (electron/richPresence.js) in the real desktop app under Xvfb: Bob's app,
// with a stand-in Steam library in its home folder, listens on discord-ipc-0; a stand-in
// Steam game (SteamAppId in its environment) and a non-Steam one (a Windows .exe in its
// arguments, as Wine shows it) connect and set activities in Discord's protocol. Alice (Chrome)
// sees "Playing …" in her DM list and the guild member list, both on Bob's card with Steam's
// cover and the time ticking; a game leaving takes its activity away; Settings → Desktop App's
// "Share what I'm playing" off closes the socket and clears it, on opens it again. A music
// player giving its cover as a web address (Feishin with Navidrome) shows that cover, fetched
// by Bob's app only.
//   node e2e/serve.mjs &   (the client built for the desktop app against it first: README,
//   "The real desktop app")   then   node e2e/richpresence.mjs [screenshot dir]
// E2E_RP_DISPLAY (:93) and E2E_RP_CDP_PORT (9341) if those are taken.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { launchChrome, signUp, makeFriends, openChat, send } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
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

// Bob's computer: a home folder with Steam in it, and its own runtime folder for the socket.
const scratch = mkdtempSync(join(tmpdir(), 'voicaw-rp-'));
const home = join(scratch, 'home');
const run = join(scratch, 'run');
const steam = join(home, '.local', 'share', 'Steam');
mkdirSync(join(steam, 'steamapps'), { recursive: true });
mkdirSync(join(steam, 'appcache', 'librarycache'), { recursive: true });
mkdirSync(run, { recursive: true, mode: 0o700 });
writeFileSync(join(steam, 'steamapps', 'appmanifest_367520.acf'),
  '"AppState"\n{\n\t"appid"\t\t"367520"\n\t"name"\t\t"Hollow Knight"\n\t"installdir"\t\t"Hollow Knight"\n}\n');
execFileSync('convert', ['-size', '600x900', 'gradient:#2a6fdb-#f0a020', join(steam, 'appcache', 'librarycache', '367520_library_600x900.jpg')]);

// A game: Discord's RPC client in a few lines (frames: opcode, length, JSON).
const gameFile = join(scratch, 'game.cjs');
writeFileSync(gameFile, `
const net = require('net');
const [socketPath, json] = process.argv.slice(2);
const frame = (op, data) => { const body = Buffer.from(JSON.stringify(data)); const h = Buffer.alloc(8); h.writeUInt32LE(op, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
const socket = net.createConnection(socketPath, () => {
  socket.write(frame(0, { v: 1, client_id: '123456789012345678' }));
  setTimeout(() => socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: JSON.parse(json) }, nonce: '1' })), 300);
});
socket.on('data', () => {});
socket.on('close', () => process.exit(0));
setInterval(() => {}, 1000);
`);
const games = [];
function startGame(activity, { env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [gameFile, join(run, 'discord-ipc-0'), JSON.stringify(activity), ...args],
    { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' });
  games.push(child);
  return child;
}

const display = process.env.E2E_RP_DISPLAY || ':93';
const cdpPort = process.env.E2E_RP_CDP_PORT || '9341';
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24'], { stdio: 'ignore' });
let electron = null;
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bobWeb = await signUp(browser, 'bob');
  await makeFriends(alice, bobWeb);
  // A guild with both in it, for the member list.
  const guildId = await alice.page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const guild = await (await fetch('/api/guilds', { method: 'POST', headers, body: JSON.stringify({ name: 'Gamers' }) })).json();
    const invite = await (await fetch(`/api/guilds/${guild.id}/invites`, { method: 'POST', headers })).json();
    window.__invite = invite.code;
    return guild.id;
  });
  const code = await alice.page.evaluate(() => window.__invite);
  await bobWeb.page.evaluate(async (c) => {
    await fetch(`/api/invites/${c}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  }, code);
  await bobWeb.page.context().close();

  // Bob's desktop app.
  await sleep(500);
  electron = spawn(join(root, 'node_modules/electron/dist/electron'),
    [join(root, 'electron/main.js'), '--no-sandbox', `--remote-debugging-port=${cdpPort}`],
    { env: { ...process.env, DISPLAY: display, HOME: home, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_RUNTIME_DIR: run }, stdio: 'ignore' });
  check(await until(() => existsSync(join(run, 'discord-ipc-0'))), 'the app listens on discord-ipc-0');
  let app = null;
  await until(async () => {
    app ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    return app.contexts().flatMap((c) => c.pages()).some((p) => p.url().startsWith('voicaw://app/'));
  }, 30000);
  const bob = app.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('voicaw://app/'));
  bob.on('pageerror', (e) => console.log('[bob app] page error:', e.message));
  await bob.waitForSelector('input[placeholder="Username"]', { timeout: 30000 });
  await bob.fill('input[placeholder="Username"]', bobWeb.name);
  await bob.fill('input[placeholder="Password"]', bobWeb.password);
  await bob.press('input[placeholder="Password"]', 'Enter');
  await bob.waitForSelector('#dm-main', { timeout: 30000 });

  // A Steam game: named and pictured from Steam's files.
  startGame({ details: 'Forgotten Crossroads', state: 'Steel Soul', timestamps: { start: Math.floor(Date.now() / 1000) - 90 }, party: { size: [2, 4] }, assets: { large_image: 'hk', large_text: 'The Knight' } },
    { env: { SteamAppId: '367520' } });
  const page = alice.page;
  // (Friends made through the API, while open, show without a name until a reload.)
  await page.reload();
  await page.waitForSelector('.friends-row');
  const friendRow = page.locator(`.friends-row:has-text("${bobWeb.name}") .friends-subtitle`);
  check(await until(async () => (await friendRow.textContent()) === 'Playing Hollow Knight'), 'Friends: "Playing Hollow Knight" under Bob');

  // A game outside Steam: its .exe's name; it's the latest, so lists show it.
  startGame({ state: 'Chapter 3' }, { args: ['Z:\\Games\\Celeste\\Celeste.exe'] });
  check(await until(async () => (await friendRow.textContent()) === 'Playing Celeste'), 'a non-Steam game is named from its .exe, the latest shown');
  if (shots) await page.screenshot({ path: join(shots, 'friends.png') });

  // In the DM list once they've talked.
  await openChat(page, bobWeb.id);
  await send(page, 'gg');
  const dmRow = page.locator(`.dm-user:has-text("${bobWeb.name}") .dm-user-custom-status`);
  check(await until(async () => (await dmRow.textContent()) === 'Playing Celeste'), 'DM list: the activity under his name');
  // The card from clicking his name in the chat.
  await bob.goto(`voicaw://app/dm/${alice.id}`);
  await bob.waitForSelector('#dm-input');
  await bob.click('#dm-input');
  await bob.keyboard.type('hi from the game');
  await bob.keyboard.press('Enter');
  await page.locator('text=hi from the game').waitFor();
  await page.locator(`.message-author:has-text("${bobWeb.name}"), .msg-author:has-text("${bobWeb.name}")`).last().click();
  const popover = page.locator('.profile-popover');
  check(await until(async () => (await popover.locator('.activity').count()) === 2), "the card from his name in chat shows what he's playing");
  if (shots) await page.screenshot({ path: join(shots, 'chat-card.png') });
  await page.keyboard.press('Escape');
  if (shots) await page.screenshot({ path: join(shots, 'dm-list.png') });

  await page.goto(`${page.url().split('/').slice(0, 3).join('/')}/guild/${guildId}`);
  const memberRow = page.locator(`.member-row:has-text("${bobWeb.name}")`);
  check(await until(async () => (await memberRow.locator('.member-activity').textContent()) === 'Playing Celeste'), 'member list: the activity under his name');
  await memberRow.click();
  const card = page.locator('.profile-card').first();
  await card.locator('.activity').first().waitFor();
  const sections = await card.locator('.activity').allTextContents();
  check(sections.length === 2, `his card shows both games (${sections.length})`);
  const hk = card.locator('.activity:has-text("Hollow Knight")');
  check((await hk.textContent()).includes('Forgotten Crossroads') && (await hk.textContent()).includes('Steel Soul (2 of 4)'), 'with what the game says and the party size');
  const cover = hk.locator('img.activity-image');
  check(await until(() => cover.evaluate((img) => img.complete && img.naturalWidth === 128)), "Steam's cover, made 128 px by the app, loads from the API");
  check((await cover.getAttribute('title')) === 'The Knight', "the game's picture text on hover");
  const timeText = async () => (await hk.locator('.activity-text div').last().textContent());
  const first = await timeText();
  check(/^\d+:\d\d elapsed$/.test(first) && Number(first.split(':')[0]) >= 1, `time played from the game's start (${first})`);
  check(await until(async () => (await timeText()) !== first, 3000), 'and it ticks');
  check(await card.locator('.activity:has-text("Celeste") .activity-image-none').count() === 1, 'no picture: a gamepad');
  if (shots) await page.screenshot({ path: join(shots, 'member-card.png') });

  // The Steam game quits: only Celeste is left.
  games[0].kill();
  check(await until(async () => (await card.locator('.activity').count()) === 1), 'a game that quits leaves the card');

  // Sharing off: the socket goes, and so does the activity.
  await bob.goto('voicaw://app/settings/desktop-app');
  await bob.waitForSelector('#settings-activity', { timeout: 15000 }).catch(async () => {
    if (shots) await bob.screenshot({ path: join(shots, 'settings-missing.png') });
    console.log('[bob app] at', bob.url());
  });
  const toggle = bob.locator('label:has-text("Share what I\'m playing") input');
  check(await toggle.isChecked(), 'Share what I\'m playing is on by default');
  if (shots) await bob.screenshot({ path: join(shots, 'settings.png') });
  // (A click: the box follows once the app has saved it.)
  await toggle.click();
  check(await until(() => !existsSync(join(run, 'discord-ipc-0'))), 'off: the app stops listening');
  check(await until(async () => (await memberRow.locator('.member-activity').count()) === 0), 'and Alice no longer sees it');
  await toggle.click();
  check(await until(() => existsSync(join(run, 'discord-ipc-0'))), 'on again: listening again');
  startGame({ details: 'Back again' }, { env: { SteamAppId: '367520' } });
  check(await until(async () => (await memberRow.locator('.member-activity').textContent()) === 'Playing Hollow Knight'), 'and new games show');

  // A music player whose cover is a web address on its server (stand-in: a server here).
  execFileSync('convert', ['-size', '300x300', 'gradient:#d02090-#30c0a0', join(scratch, 'cover.jpg')]);
  const coverRequests = [];
  const coverServer = http.createServer((req, res) => {
    coverRequests.push(req.headers['user-agent'] ?? '');
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(readFileSync(join(scratch, 'cover.jpg')));
  });
  await new Promise((resolve) => coverServer.listen(0, '127.0.0.1', resolve));
  const coverUrl = `http://127.0.0.1:${coverServer.address().port}/share/img/token?size=300`;
  startGame({ type: 2, details: 'Song Title', state: 'Some Artist', assets: { large_image: coverUrl, large_text: 'The Album', small_image: 'playing' } },
    {});
  check(await until(async () => /^Listening to /.test(await memberRow.locator('.member-activity').textContent())), 'a music player: "Listening to …"');
  if (!(await page.locator('.member-card').count())) await memberRow.click();
  const song = page.locator('.profile-card .activity:has-text("Song Title")');
  await song.waitFor();
  const songCover = song.locator('img.activity-image');
  check(await until(() => songCover.evaluate((img) => img.complete && img.naturalWidth === 128)), "its cover from the address it gave, made 128 px");
  check((await songCover.getAttribute('src')).includes('/activity-images/'), 'served by the API, not the music server');
  check(coverRequests.length === 1 && !/Chrome/.test(coverRequests[0]), `the music server was asked once, by Bob's app (${coverRequests.length})`);
  if (shots) await page.screenshot({ path: join(shots, 'music.png') });
  coverServer.close();
} finally {
  for (const game of games) game.kill();
  electron?.kill();
  await browser.close();
  await sleep(500);
  xvfb.kill();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
