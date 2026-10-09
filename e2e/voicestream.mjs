// "Streaming in …" (utils/voiceStreams.js): Bob goes Live in a guild voice channel (Chrome's
// fake screen, through the e2e LiveKit). Alice sees "Streaming in lounge" under his name in the
// member list and her DM list, also after a reload before the guild is opened; his card's
// Streaming section names the channel and guild and its link opens the channel; it goes when he
// stops. In a private voice channel only those who can see it learn he's streaming: Carol,
// in the guild without access, sees nothing (live, or after a reload).
//   node e2e/serve.mjs &   then   node e2e/voicestream.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, makeFriends, openChat, send, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(test).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const VIEW_CHANNEL = 1 << 0;
const CONNECT = 1 << 12;
const SPEAK = 1 << 13;
const STREAM = 1 << 19;

const browser = await launchChrome({ args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const [a, b, c] = [alice.page, bob.page, carol.page];

  // Alice's guild, with a voice channel everyone sees and a private one only Bob (and she) can.
  const guild = await api(a, 'POST', '/guilds', { name: 'Streamers' });
  const lounge = await api(a, 'POST', `/guilds/${guild.id}/channels`, { name: 'lounge', type: 'voice' });
  const secret = await api(a, 'POST', `/guilds/${guild.id}/channels`, { name: 'secret', type: 'voice' });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`);
  for (const page of [b, c]) await api(page, 'POST', `/invites/${invite.code}`);
  await api(a, 'PUT', `/guilds/${guild.id}/channels/${secret.id}/overrides/member/${bob.id}`, { allow: VIEW_CHANNEL | CONNECT | SPEAK | STREAM, deny: 0 });
  await api(a, 'PUT', `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${guild.id}`, { allow: 0, deny: VIEW_CHANNEL });
  // Bob is in Alice's DM list.
  await makeFriends(alice, bob);
  await openChat(b, alice.id);
  await send(b, 'watch this');

  // Bob goes Live in the lounge.
  await b.goto(`${BASE}/guild/${guild.id}/${lounge.id}`);
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.voice-bar button[aria-label="Share your screen"]');
  await b.click('.go-live-dialog button:has-text("Go Live")');
  await b.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 15000 });

  // Alice: her DM list, before she opens the guild, and after a reload (from the guild list).
  await openChat(a, bob.id);
  const dmLine = a.locator(`.dm-user:has-text("${bob.name}") .dm-user-custom-status`);
  check(await until(async () => (await dmLine.textContent()) === 'Streaming in lounge'), 'DM list: "Streaming in lounge" under Bob');
  await a.reload();
  check(await until(async () => (await dmLine.textContent()) === 'Streaming in lounge'), 'still there after a reload, guild not opened');
  check(await dmLine.locator('svg[data-icon="tower-broadcast"]').count() === 1, 'with the broadcast icon');
  await shot(a, 'dm-list');

  // The member list, and his card.
  await a.goto(`${BASE}/guild/${guild.id}`);
  const row = a.locator(`.member-row:has-text("${bob.name}")`);
  check(await until(async () => (await row.locator('.member-activity').textContent()) === 'Streaming in lounge'), 'member list: the same under his name');
  await row.click();
  const section = a.locator('.member-card .activity-stream');
  await section.waitFor();
  const text = await section.textContent();
  check(text.includes('Streaming') && text.includes('lounge') && text.includes('Streamers'), `his card: Streaming, the channel and the guild (${text})`);
  await shot(a, 'card');
  await section.locator('a:has-text("Go to channel")').click();
  check(await until(() => a.url().endsWith(`/guild/${guild.id}/${lounge.id}`)), 'Go to channel opens the voice channel');

  // He stops: it goes.
  await b.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await openChat(a, bob.id);
  check(await until(async () => (await dmLine.count()) === 0 || (await dmLine.textContent()) === ''), 'gone when he stops sharing');

  // The private channel: Alice sees it, Carol (no access) never does.
  await b.goto(`${BASE}/guild/${guild.id}/${secret.id}`);
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.voice-bar button[aria-label="Share your screen"]');
  await b.click('.go-live-dialog button:has-text("Go Live")');
  await b.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 15000 });
  check(await until(async () => (await dmLine.textContent()) === 'Streaming in secret'), 'Alice (who can see it): "Streaming in secret"');
  await c.goto(`${BASE}/guild/${guild.id}`);
  const carolRow = c.locator(`.member-row:has-text("${bob.name}")`);
  await carolRow.waitFor();
  await sleep(1500);
  check(await carolRow.locator('.member-activity').count() === 0, 'Carol (no access): nothing in the member list');
  await carolRow.click();
  await c.locator('.member-card').waitFor();
  check(await c.locator('.member-card .activity-stream').count() === 0, 'nor on his card');
  await c.reload();
  await carolRow.waitFor();
  await sleep(1500);
  check(await carolRow.locator('.member-activity').count() === 0, 'nor after a reload');
  await shot(c, 'carol');
} finally {
  await browser.close();
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
