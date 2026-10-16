// The app's picture on voicaw.com (website/src/screenshot-*.png): four people and a guild with
// a few channels and a short conversation, then #general on a computer and on a phone (the
// app's default dark theme). Re-run it when the app's look changes enough that the site's pictures are wrong.
//   node e2e/serve.mjs &   then   node e2e/sitescreenshot.mjs [dir, default website/src]
import fs from 'node:fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2] || new URL('../website/src', import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });

const call = (user, method, path, body) => user.page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const browser = await launchChrome();
// A busy host can take over a minute to serve the dev client to a new context.
const patient = { newContext: async (options) => {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(180000);
  return context;
} };
try {
  const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' };
  const people = {};
  for (const [key, displayName] of [['maya', 'Maya'], ['tom', 'Tom'], ['priya', 'Priya'], ['jonno', 'Jonno']]) {
    people[key] = await signUp(patient, key, desktop);
    await call(people[key], 'PUT', '/profile', { displayName });
  }
  // A picture each (a colour and an initial, drawn in the page), uploaded as Settings does.
  const colours = { maya: '#d9822b', tom: '#2f7d4f', priya: '#b03a5b', jonno: '#2f63b5' };
  for (const [key, p] of Object.entries(people)) {
    await p.page.evaluate(async ([colour, letter]) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const g = canvas.getContext('2d');
      g.fillStyle = colour;
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#fff';
      g.font = '600 128px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(letter, 128, 138);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const auth = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
      const { url, uploadId } = await (await fetch('/api/profile/avatar', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'image/png', size: blob.size }) })).json();
      await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
      const ready = await fetch(`/api/profile/avatar/${uploadId}/ready`, { method: 'POST', headers: auth, body: '{}' });
      if (!ready.ok) throw new Error(`picture: ${ready.status}`);
    }, [colours[key], key[0].toUpperCase()]);
  }
  const { maya, tom, priya, jonno } = people;

  const guild = await call(maya, 'POST', '/guilds', { name: 'The Flat' });
  const general = guild.channels.find((c) => c.name === 'general');
  const textCategory = general.category_id;
  for (const name of ['bin-day', 'food']) await call(maya, 'POST', `/guilds/${guild.id}/channels`, { name, categoryId: textCategory });
  await call(maya, 'POST', `/guilds/${guild.id}/channels`, { name: 'shopping', type: 'list', categoryId: textCategory });
  await call(maya, 'POST', `/guilds/${guild.id}/channels`, { name: 'house-rules', type: 'doc', categoryId: textCategory });
  const voice = await call(maya, 'POST', `/guilds/${guild.id}/categories`, { name: 'Voice Channels' });
  await call(maya, 'POST', `/guilds/${guild.id}/channels`, { name: 'Living room', type: 'voice', categoryId: voice.id });
  await call(maya, 'POST', `/guilds/${guild.id}/channels`, { name: 'Gaming', type: 'voice', categoryId: voice.id });
  const invite = await call(maya, 'POST', `/guilds/${guild.id}/invites`, {});
  for (const p of [tom, priya, jonno]) await call(p, 'POST', `/invites/${invite.code}`);

  const say = async (p, content) => (await call(p, 'POST', `/channels/${general.id}/messages`, { content })).id;
  const react = (p, id, emoji) => call(p, 'POST', `/guild-messages/${id}/reactions`, { emoji });
  await say(jonno, 'who took the last of the oat milk');
  await say(priya, 'not me, I drink it black like my soul');
  const tomSorry = await say(tom, "ok that was me. I'll get more on the way back");
  await react(jonno, tomSorry, '🙏');
  await say(maya, 'while you\'re there can you grab bin bags? they\'re on the list in #shopping');
  const pizza = await say(priya, 'pizza tonight? I can order around 7');
  for (const p of [maya, tom, jonno]) await react(p, pizza, '🍕');
  await react(jonno, pizza, '🔥');
  await say(jonno, 'yes. pineapple is not up for debate');
  const film = await say(maya, 'and film after? I\'ll share my screen in **Living room**');
  await react(tom, film, '👍');
  await react(priya, film, '👍');

  const shoot = async (context, name) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
    await page.waitForSelector('.guild-header-name:has-text("The Flat")');
    await page.waitForSelector('text=pineapple is not up for debate');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${dir}/${name}.png` });
    console.log(`${dir}/${name}.png`);
    await page.close();
  };
  // Maya's own account, on each device (the token is the page's localStorage).
  const state = await maya.page.context().storageState();
  const computer = await patient.newContext({ ...desktop, storageState: state });
  await shoot(computer, 'screenshot-desktop');
  await computer.close();
  const phone = await patient.newContext({ ...devices['Pixel 7'], colorScheme: 'dark', storageState: state });
  await shoot(phone, 'screenshot-phone');
  await phone.close();
} finally {
  await browser.close();
}
