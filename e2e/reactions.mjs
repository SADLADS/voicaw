// Reaction notifications in a real browser. Bob is the desktop app (a stand-in bridge records its
// notifications, as in previewprivacy.mjs). Alice reacts to his DM: he's told, with the emoji and
// his message's text, decrypted on his device. Alice votes in his DM poll: nothing (a vote is a
// reaction the server can't tell apart; his app opens it and drops it). Alice reacts to his guild
// message: he's told. Settings → Notifications → "Reactions to your messages" → Never: nothing.
//   node e2e/serve.mjs &   then   node e2e/reactions.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

function fakeBridge() {
  const record = { notifications: [] };
  window.__desktop = { record };
  const on = () => () => () => {};
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: (n) => record.notifications.push(n),
    setUnread: () => {},
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, shortcuts: {} }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: async () => {},
    onNavigate: on(), onShortcut: on(), onUpdateReady: on(), onUpdateProgress: on(),
  };
}

const api = (p, method, path, body) => p.evaluate(async ([m, url, b]) => {
  const res = await fetch(`/api${url}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return res.json();
}, [method, path, body]);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;
  const bobContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await bobContext.addInitScript(fakeBridge);
  const bob = await signUp(browser, 'bob').then(async (made) => {
    const page = await bobContext.newPage();
    page.on('pageerror', (e) => console.log('[bob desktop] page error:', e.message));
    await page.goto(`${BASE}/`);
    await page.fill('input[placeholder="Username"]', made.name);
    await page.fill('input[placeholder="Password"]', made.password);
    await page.press('input[placeholder="Password"]', 'Enter');
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await made.page.context().close();
    return { ...made, page };
  });
  const b = bob.page;
  if (process.env.DEBUG_WS) {
    b.on('websocket', (ws) => ws.on('framereceived', (f) => {
      if (String(f.payload).includes('"notification"')) console.log(`[${new Date().toISOString()}] bob ws:`, String(f.payload).slice(0, 160));
    }));
  }
  const notifications = () => b.evaluate(() => window.__desktop.record.notifications.map(({ title, body }) => ({ title, body })));
  const nextNotification = async () => {
    await b.waitForFunction(() => window.__desktop.record.notifications.length > 0, null, { timeout: 15000 });
    return (await notifications())[0];
  };
  // Bob somewhere else (so he's notified), once the server has his page's presence. The
  // bridge's record starts again with the page load (a new query each time: the same URL with
  // a #hash wouldn't load the page again).
  const away = async () => {
    await b.goto(`${BASE}/settings?at=${Date.now()}#notifications`);
    await b.waitForLoadState('networkidle');
    await b.waitForTimeout(1500);
  };

  console.log('DM');
  await openChat(b, alice.id); // checks Alice's keys on Bob's device
  await send(b, 'lunch at noon');
  await b.click('.attach-button');
  await b.click('.composer-add-item:has-text("Create poll")');
  await b.fill('#poll-question', 'Pizza?');
  await b.fill('input[aria-label="Answer 1"]', 'Yes');
  await b.fill('input[aria-label="Answer 2"]', 'No');
  await b.click('.vc-dialog button:has-text("Post")');
  await b.waitForSelector('.poll-question:text-is("Pizza?")');
  await away();

  await openChat(a, bob.id);
  const content = a.locator('.dm-message-content', { hasText: /^lunch at noon$/ });
  await content.click({ button: 'right' });
  await a.click('.context-menu-reaction[aria-label="React with Thumbs Up"]');
  await a.locator('.each-dm-message-wrapper', { has: content })
    .locator('.message-reactions button[aria-pressed="true"]').waitFor({ timeout: 10000 });
  const n = await nextNotification();
  check(n.title === alice.name, `titled with who reacted (${n.title})`);
  check(n.body === "Reacted 👍 to your message: lunch at noon", `"Reacted 👍 to your message: lunch at noon" (${n.body})`);
  await shot(b, 'settings');

  console.log('DM poll vote');
  await away();
  const poll = a.locator('.poll:has(.poll-question:text-is("Pizza?"))');
  await poll.locator('.poll-option:has-text("Yes")').click();
  await poll.locator('button:text-is("Vote")').click();
  await poll.locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
  await b.waitForTimeout(3000);
  check((await notifications()).length === 0, `a vote notifies nothing (${JSON.stringify(await notifications())})`);

  console.log('guild');
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Reacts');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const [, , guildId, channelId] = new URL(a.url()).pathname.split('/');
  const { code } = await api(a, 'POST', `/guilds/${guildId}/invites`);
  await api(b, 'POST', `/invites/${code}`);
  const first = await api(b, 'POST', `/channels/${channelId}/messages`, { content: 'first post' });
  const second = await api(b, 'POST', `/channels/${channelId}/messages`, { content: 'second post' });
  await away();
  await api(a, 'POST', `/guild-messages/${first.id}/reactions`, { emoji: '🎉' });
  const g = await nextNotification();
  check(g.body === 'Reacted 🎉 to your message: first post' && g.title.includes('#general, Reacts'), `guild reaction (${JSON.stringify(g)})`);

  console.log('setting');
  const card = b.locator('.settings-card:has(h5:text-is("Reactions to your messages"))');
  check(await card.getByLabel('Everywhere').isChecked(), 'Everywhere by default');
  await shot(b, 'settings-card');
  await card.getByLabel('Never').check();
  await b.waitForFunction(async () => {
    const res = await fetch('/api/preferences', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).reactionNotifications === 'off';
  });
  await away();
  check(await card.getByLabel('Never').isChecked(), 'kept after a reload');
  await api(a, 'POST', `/guild-messages/${second.id}/reactions`, { emoji: '👀' });
  await b.waitForTimeout(3000);
  check((await notifications()).length === 0, 'Never: nothing');
  await card.getByLabel('Everywhere').check();

  console.log('phone');
  const phone = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await phone.page.goto(`${BASE}/settings#notifications`);
  const phoneCard = phone.page.locator('.settings-card:has(h5:text-is("Reactions to your messages"))');
  await phoneCard.scrollIntoViewIfNeeded();
  const box = await phoneCard.boundingBox();
  const width = await phone.page.evaluate(() => document.documentElement.clientWidth);
  check(box && box.x >= 0 && box.x + box.width <= width + 1, `the card fits the phone's width (${JSON.stringify(box)}, ${width})`);
  await phoneCard.getByLabel('Only in DMs and group DMs').tap();
  await phone.page.waitForFunction(async () => {
    const res = await fetch('/api/preferences', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).reactionNotifications === 'dms';
  });
  check(true, 'a tap saves it');
  await shot(phone.page, 'settings-phone');
  console.log('all good');
} finally {
  await browser.close();
}
