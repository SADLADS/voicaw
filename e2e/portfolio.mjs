// Portfolio screenshots with made-up data (not a check): the plane scene from The Dark Knight
// Rises as a guild (chat, a list, documents, events, voice) and an encrypted DM; seen as CIA.
//   node e2e/serve.mjs &   then   node e2e/portfolio.mjs <dir>
import fs from 'node:fs';
import { launchChrome, signUp, devices, fakeMicArgs, makeFriends, openChat, send, BASE } from './helpers.mjs';

const dir = process.argv[2];
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

const browser = await launchChrome({ args: fakeMicArgs({ phrases: true }) });
const patient = { newContext: async (options) => {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'], ...options });
  context.setDefaultTimeout(180000);
  return context;
} };
const settle = async (page) => {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  await page.mouse.move(0, 0);
};
const shot = async (page, name) => {
  await page.screenshot({ path: `${dir}/${name}.png` });
  console.log(`${dir}/${name}.png`);
};

try {
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' };
  const cast = [
    ['cia', 'CIA', '#2f63b5', 'C'],
    ['pavel', 'Dr. Pavel', '#b03a5b', 'P'],
    ['driver', 'Masketta Man', '#d9822b', 'M'],
    ['bane', 'Bane', '#4a4a4a', 'B'],
    ['wreckage', 'Wreckage brother', '#2f7d4f', 'W'],
  ];
  const people = {};
  for (const [key, displayName, colour, letter] of cast) {
    people[key] = await signUp(patient, key, desktop);
    await call(people[key], 'PUT', '/profile', { displayName });
    await people[key].page.evaluate(async ([colour, letter]) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const g = canvas.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 256, 256);
      grad.addColorStop(0, colour);
      grad.addColorStop(1, '#111');
      g.fillStyle = grad;
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
    }, [colour, letter]);
  }
  const { cia, pavel, driver, bane, wreckage } = people;
  await makeFriends(cia, pavel, driver, bane, wreckage);

  // The guild.
  const guild = await call(cia, 'POST', '/guilds', { name: 'Operation Pavel' });
  const general = guild.channels.find((c) => c.name === 'general');
  const text = general.category_id;
  for (const name of ['briefings', 'intel']) await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name, categoryId: text });
  const list = await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name: 'flight-plan', type: 'list', categoryId: text });
  const docs = await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name: 'mission-files', type: 'doc', categoryId: text });
  const voiceCat = await call(cia, 'POST', `/guilds/${guild.id}/categories`, { name: 'Voice Channels' });
  const plane = await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name: 'plane', type: 'voice', categoryId: voiceCat.id });
  await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name: 'wreckage', type: 'voice', categoryId: voiceCat.id });
  await call(cia, 'POST', `/guilds/${guild.id}/channels`, { name: 'afk', type: 'voice', categoryId: voiceCat.id });
  const invite = await call(cia, 'POST', `/guilds/${guild.id}/invites`, {});
  for (const p of [pavel, driver, bane, wreckage]) await call(p, 'POST', `/invites/${invite.code}`);

  const say = async (p, content) => (await call(p, 'POST', `/channels/${general.id}/messages`, { content })).id;
  const react = (p, id, emoji) => call(p, 'POST', `/guild-messages/${id}/reactions`, { emoji });
  await react(pavel, await say(cia, `<@${pavel.id}>, I'm CIA.`), '👋');
  await react(cia, await say(driver, "He wasn't alone."), '❓');
  await say(cia, "You don't get to bring *friends*.");
  await say(pavel, 'They are *not* my friends');
  await say(driver, "Don't worry, no charge for them.");
  await say(cia, 'Why would I want them?');
  await say(driver, 'They were trying to grab your prize. 😏 They work for the mercenary. The masked man.');
  await react(driver, await say(cia, `<@${bane.id}>?`), '✅');
  const LAST = "Get 'em on board - I'll call it in.";
  await say(cia, LAST);

  // The list: the flight plan, filed, but one passenger short.
  const task = (body) => call(cia, 'POST', `/channels/${list.id}/tasks`, body);
  const plan = await task({ title: 'File flight plan with the agency', assigneeIds: [cia.id] });
  const subtasks = {};
  for (const title of ['Me', 'My Men', 'Dr. Pavel here', 'One of you']) subtasks[title] = await task({ title, parentId: plan.id });
  await call(cia, 'PATCH', `/tasks/${plan.id}`, { completed: true });
  for (const [title, t] of Object.entries(subtasks)) await call(cia, 'PATCH', `/tasks/${t.id}`, { completed: title !== 'One of you' });

  // Documents.
  await call(cia, 'POST', `/channels/${docs.id}/documents`, {
    title: 'Flight manifest',
    content: 'Agency transfer of **Dr. Leonid Pavel**, nuclear physicist, from the airstrip to the extraction point.\n\n## Passengers\n\n| Who | Status |\n| --- | --- |\n| Me | Filed |\n| My men | Filed |\n| Dr. Pavel | Filed, hooded |\n| Three prisoners | **Not filed** |\n\n## Brief\n\n- Pick-up from the local driver at the airstrip, cash on delivery\n- Prisoners say they work for the masked man, **Bane**\n- Interrogate in the air: whoever talks first gets to stay on board\n\n## Rules on board\n\n1. Hoods stay on until we are airborne\n2. Nobody cared who they were until they put on the mask\n3. No one is to be thrown out of the plane without my say-so\n4. The flight plan lists **one** of you. Decide which.\n',
  });
  await call(cia, 'POST', `/channels/${docs.id}/documents`, {
    title: 'Interrogation notes: the masked man',
    content: 'Big guy. Says it doesn\'t matter who they are, only the plan. Asked if he\'d die if I pulled this off. Answer: "It would be extremely painful." Follow up.\n',
  });

  // Events (unix seconds).
  const today = new Date();
  const at = (days, hour) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await call(cia, 'POST', `/guilds/${guild.id}/events`, { name: 'Prisoner pick-up', entityType: 'external', location: 'Airstrip, Uzbekistan', startTime: at(1, 6), endTime: at(1, 7), timezone: tz, emoji: '🚙' });
  await call(cia, 'POST', `/guilds/${guild.id}/events`, { name: 'Flight to extraction', entityType: 'voice', channelId: plane.id, startTime: at(1, 8), endTime: at(1, 11), timezone: tz, emoji: '✈️' });
  await call(cia, 'POST', `/guilds/${guild.id}/events`, { name: 'Pavel debrief', entityType: 'external', location: 'Langley', startTime: at(4, 10), endTime: at(4, 12), timezone: tz, emoji: '☢️' });
  await call(cia, 'POST', `/guilds/${guild.id}/events`, { name: 'Report on the masked man', entityType: 'external', location: 'Agency HQ', startTime: at(9, 14), endTime: at(9, 15), timezone: tz, emoji: '🎭' });

  // The encrypted DM between CIA and Bane, through the real app.
  const content = (page, t) => page.locator('.dm-message-content', { hasText: t });
  await openChat(bane.page, cia.id);
  await send(bane.page, "It doesn't matter who we are. What matters is our plan.");
  await openChat(cia.page, bane.id);
  await content(cia.page, 'What matters is our plan').waitFor();
  await send(cia.page, 'If I pull this off, will you die?');
  await content(bane.page, 'will you die?').waitFor();
  await send(bane.page, 'It would be extremely painful.');
  await content(cia.page, 'extremely painful').waitFor();
  await send(cia.page, "You're a big guy.");
  await content(bane.page, 'big guy').waitFor();
  await send(bane.page, 'For you.');
  await content(cia.page, 'For you.').waitFor();
  await content(cia.page, 'For you.').click({ button: 'right' });
  await cia.page.click('.context-menu [role="menuitem"]:has-text("Add Reaction")');
  await cia.page.fill('.emoji-picker input[type="search"]', 'flushed');
  await cia.page.click('.emoji-picker-item[aria-label="Flushed Face"]');
  await cia.page.locator('.each-dm-message-wrapper', { has: content(cia.page, 'For you.') }).locator('.reaction-chip.mine').waitFor();

  // Voice: Dr. Pavel, Masketta Man and Bane on the plane, the Wreckage brother in wreckage.
  for (const [p, channel] of [[pavel, 'plane'], [driver, 'plane'], [bane, 'plane'], [wreckage, 'wreckage']]) {
    await p.page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
    await p.page.click(`.guild-channel-link:has-text("${channel}")`);
    await p.page.waitForSelector('.voice-bar-status.connected', { timeout: 30000 });
  }

  // CIA's views, from CIA's own page (its keys are in IndexedDB, which storageState copies with
  // indexedDB: true).
  const state = await cia.page.context().storageState({ indexedDB: true });
  const page = cia.page;

  await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await page.waitForSelector(`text=${LAST}`);
  await settle(page);
  await shot(page, '01-guild-chat');

  await page.goto(`${BASE}/dm/${bane.id}`);
  await content(page, 'For you.').waitFor();
  await settle(page);
  await shot(page, '02-encrypted-dm');

  await page.goto(`${BASE}/guild/${guild.id}/${list.id}`);
  await page.waitForSelector('.task-title:text-is("One of you")');
  await settle(page);
  await shot(page, '03-list-channel');

  await page.goto(`${BASE}/guild/${guild.id}/${docs.id}`);
  await page.waitForSelector('.document-card-title:has-text("Flight manifest")');
  await settle(page);
  await shot(page, '04-documents');
  await page.click('button[aria-label="Open Flight manifest"]');
  await page.waitForSelector('text=Decide which');
  await settle(page);
  await shot(page, '05-document');

  await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await page.waitForSelector(`text=${LAST}`);
  await page.click('.guild-events-button');
  await page.waitForSelector('.event-calendar-grid');
  await settle(page);
  await shot(page, '06-calendar');
  await page.keyboard.press('Escape');

  // CIA boards the plane too.
  await page.click('.guild-channel-link:has-text("plane")');
  await page.waitForSelector('.voice-bar-status.connected', { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.mouse.move(0, 0);
  await shot(page, '07-voice-channel');

  // Light theme.
  const light = await patient.newContext({ ...desktop, colorScheme: 'light', storageState: state });
  await light.addInitScript(() => localStorage.setItem('theme', 'light'));
  const lp = await light.newPage();
  await lp.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await lp.waitForSelector(`text=${LAST}`);
  await settle(lp);
  await shot(lp, '08-guild-chat-light');
  await light.close();

  // Phone, logged in for real so it has CIA's keys.
  const phone = await patient.newContext({ ...devices['Pixel 7'], colorScheme: 'dark' });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/`);
  await pp.fill('input[placeholder="Username"]', cia.name);
  await pp.fill('input[placeholder="Password"]', cia.password);
  await pp.click('button:has-text("Login")');
  await pp.waitForSelector('#dm-main', { timeout: 30000 });
  await pp.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await pp.waitForSelector(`text=${LAST}`);
  await settle(pp);
  await shot(pp, '09-phone-guild-chat');
  await pp.goto(`${BASE}/dm/${bane.id}`);
  await content(pp, 'For you.').waitFor();
  await settle(pp);
  await shot(pp, '10-phone-dm');
  await pp.goto(`${BASE}/guild/${guild.id}/${list.id}`);
  await pp.waitForSelector('.task-title:text-is("One of you")');
  await settle(pp);
  await shot(pp, '11-phone-list');
  await phone.close();
} finally {
  await browser.close();
}
