// Who's watching a stream, through the e2e LiveKit (Chrome's fake screen). In a voice channel
// Alice shares: nobody else watches, so her preview shows no watchers; Bob watches and she sees
// "1 watching" with his picture (he sees nobody, not himself); Carol, on a phone, watches too:
// Alice sees both, Bob sees Carol, Carol sees Bob; the list opens on a click; Bob stops and
// he's gone from the others'. Then a DM call: Bob's stream opens by itself and Alice sees him
// watching (the call room's attribute), and not after Stop watching.
//   node e2e/serve.mjs &   then   node e2e/streamwatchers.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, fakeMicArgs, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

function check(ok, what) {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const videoPlaying = (page, scope = '') => page.waitForFunction((selector) => {
  const v = document.querySelector(`${selector} .stream-view video`);
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, scope, { timeout: 20000 });

// The stream bar's watchers button's label ("2 watching: bob, carol"), or null.
const watchersOf = (page, scope = '') => page.evaluate((selector) => (
  document.querySelector(`${selector} .stream-view .stream-watchers-button`)?.getAttribute('aria-label') ?? null
), scope);

async function waitForWatchers(page, expected, what, scope = '') {
  const deadline = Date.now() + 10000;
  let label;
  while (Date.now() < deadline) {
    label = await watchersOf(page, scope);
    if (label === expected) return check(true, `${what}: ${expected ?? 'nobody'}`);
    await page.waitForTimeout(200);
  }
  throw new Error(`failed: ${what}: expected ${expected}, saw ${label}`);
}

const tile = (name) => `.voice-tile:has-text("${name}")`;

const browser = await launchChrome({ args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Watchers Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  const guildId = /\/guild\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const channelId = /\/guild\/\d+\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');

  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await videoPlaying(a);
  await a.waitForTimeout(1000);
  await waitForWatchers(a, null, "alice's own preview before anyone watches");

  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  await waitForWatchers(a, `1 watching: ${bob.name}`, 'alice sees bob watching');
  await waitForWatchers(b, null, "bob doesn't see himself");
  check(await a.locator('.stream-watchers-pictures .user-avatar').count() === 1, "bob's picture beside the count");

  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  await waitForWatchers(a, `2 watching: ${bob.name}, ${carol.name}`, 'alice sees bob and carol');
  await waitForWatchers(b, `1 watching: ${carol.name}`, 'bob sees carol');
  await waitForWatchers(c, `1 watching: ${bob.name}`, 'carol (phone) sees bob');

  await a.click('.stream-watchers-button');
  const list = await a.locator('.stream-watchers-list').innerText();
  check(list.includes(bob.name) && list.includes(carol.name), 'the list names both');
  const listBox = await a.locator('.stream-watchers-list').boundingBox();
  const stageBox = await a.locator('.stream-view').boundingBox();
  check(listBox.y >= stageBox.y && listBox.x >= stageBox.x && listBox.x + listBox.width <= stageBox.x + stageBox.width + 1,
    'the list fits inside the stream');
  await shot(a, '01-alice-watchers-list');
  await c.click('.stream-watchers-button');
  await shot(c, '02-carol-phone-watchers');
  const phoneList = await c.locator('.stream-watchers-list').boundingBox();
  check(phoneList.x >= 0 && phoneList.x + phoneList.width <= c.viewportSize().width,
    `the list fits the phone (${Math.round(phoneList.x)}..${Math.round(phoneList.x + phoneList.width)} of ${c.viewportSize().width})`);
  await c.click('.stream-name');
  await c.waitForSelector('.stream-watchers-list', { state: 'detached' });
  check(true, 'tapping elsewhere closes it');

  await b.click('.stream-view button[aria-label="Stop watching"]');
  await waitForWatchers(a, `1 watching: ${carol.name}`, 'bob stopped: alice sees only carol');
  await waitForWatchers(c, null, 'bob stopped: carol sees nobody');

  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await c.waitForSelector('.stream-view', { state: 'detached', timeout: 10000 });
  for (const page of [a, b, c]) {
    await page.click('button[aria-label="Disconnect"]').catch(() => {});
  }
  await a.waitForSelector('.voice-bar', { state: 'detached', timeout: 10000 }).catch(() => {});

  // A DM call: Bob's view of Alice's stream opens by itself, and Alice sees him watching.
  await makeFriends(alice, bob);
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await a.waitForSelector('.call-panel-status:has-text(":")', { timeout: 20000 });
  await a.click('.call-panel button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await videoPlaying(a, '.call-panel');
  await videoPlaying(b, '.call-panel');
  await waitForWatchers(a, `1 watching: ${bob.name}`, 'in a DM call alice sees bob watching', '.call-panel');
  await shot(a, '03-dm-call-watchers');
  await b.click('.call-panel .stream-view button[aria-label="Stop watching"]');
  await waitForWatchers(a, null, 'bob stopped watching the call stream', '.call-panel');
  await b.click('.call-panel button[aria-label="Hang up"]');
  console.log('OK');
} finally {
  await browser.close();
}
