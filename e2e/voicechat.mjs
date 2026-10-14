// Voice channels' text chat, like Discord's: unread on the channel and its chat button, the chat
// opened from there without joining (?chat=1, beside the voice page in the member list's
// place), messages live both ways, joining with it open (tiles and chat side by side), kept
// open after a reload, and a phone (the header's chat button, covering the voice page, Back).
//   node e2e/serve.mjs &   then   node e2e/voicechat.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE, devices, fakeMicArgs } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Talkers' });
  const general = guild.channels[0];
  const lounge = await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' });
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);

  // Bob is in #general when Alice writes in the lounge's chat: unread there.
  const b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  await api(alice.page, 'POST', `/channels/${lounge.id}/messages`, { content: 'Anyone up for a game tonight?' });
  const loungeRow = b.locator('.guild-channel', { hasText: 'lounge' });
  await b.waitForFunction(() => document.querySelector('.guild-channel.unread')?.textContent.includes('lounge'));
  check(true, 'the voice channel is unread in the channel list');
  const chatButton = loungeRow.locator('.guild-channel-chat-button');
  check(await chatButton.isVisible(), 'its chat button shows without hovering while it has unread messages');
  await shot(b, 'unread');

  // He opens the chat from it: not joined.
  await chatButton.click();
  await b.waitForSelector('.voice-chat-pane');
  check(new URL(b.url()).searchParams.get('chat') === '1', 'the chat opens beside the channel (?chat=1)');
  await b.waitForSelector('.voice-chat-pane >> text=Anyone up for a game tonight?');
  check(true, "with Alice's message");
  check(await b.locator('.voice-view-join').isVisible(), "and he didn't join the call");
  check(!(await b.$('.member-list')), "in the member list's place");
  const paneBox = await b.locator('.voice-chat-pane').boundingBox();
  const viewBox = await b.locator('.guild-chat').boundingBox();
  check(paneBox.x >= viewBox.x + viewBox.width - 1 && paneBox.width >= 300, `right of the voice page (${Math.round(paneBox.width)}px wide)`);
  await b.waitForFunction(() => !document.querySelector('.guild-channel.unread'));
  check(true, 'read now: no longer unread');
  check(await b.evaluate(() => document.activeElement?.id === 'dm-input'), 'the message box has the focus');

  // Alice has the lounge open with its chat; Bob's reply arrives live.
  const a = alice.page;
  await a.goto(`${BASE}/guild/${guild.id}/${lounge.id}?chat=1`);
  await a.waitForSelector('.voice-chat-pane >> text=Anyone up for a game tonight?');
  await b.keyboard.type("I'm in, give me ten minutes");
  await b.keyboard.press('Enter');
  await a.waitForSelector(".voice-chat-pane >> text=I'm in, give me ten minutes");
  check(true, "Bob's reply reaches Alice live");

  // Alice joins with the chat open: tiles and chat side by side.
  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-view-controls', { timeout: 20000 });
  await a.waitForSelector(`.voice-tile:has-text("${alice.name}")`);
  check(await a.locator('.voice-chat-pane').isVisible(), 'joining keeps the chat open next to the tiles');
  await a.mouse.move(400, 400);
  await shot(a, 'joined-with-chat');
  await b.waitForSelector(`.voice-tile:has-text("${alice.name}")`);
  await shot(b, 'outside-with-chat');

  // The voice bar's chat button: lit while the chat is open, closes it.
  const barChat = a.locator('.voice-bar .voice-bar-chat');
  check((await barChat.getAttribute('class')).includes('active'), "the voice bar's chat button is lit while the chat is open");
  await barChat.click();
  await a.waitForSelector('.voice-chat-pane', { state: 'detached' });
  check(true, 'clicking it closes the chat');
  // Elsewhere in the app, a message in the lounge's chat marks it; it opens the chat, still connected.
  await a.click('.guild-channel:has-text("general") .guild-channel-link');
  await a.waitForSelector('#dm-input');
  await a.waitForSelector('.voice-bar .voice-bar-status.connected');
  await api(b, 'POST', `/channels/${lounge.id}/messages`, { content: 'Starting in five' });
  await a.waitForSelector('.voice-bar .voice-bar-chat.unread');
  check(true, "the voice bar's chat button gets a dot for the new message");
  await shot(a, 'bar-unread');
  await a.click('.voice-bar .voice-bar-chat');
  await a.waitForSelector('.voice-chat-pane >> text=Starting in five');
  check(new URL(a.url()).pathname === `/guild/${guild.id}/${lounge.id}`, 'it opens the lounge with its chat');
  check(await a.locator('.voice-bar .voice-bar-status.connected').isVisible(), 'still connected');
  await a.waitForSelector('.voice-bar .voice-bar-chat:not(.unread)');
  check(true, 'and the dot goes');

  // Bob's choice is kept: the lounge reopens with its chat after a reload.
  await b.goto(`${BASE}/guild/${guild.id}/${lounge.id}`);
  await b.waitForSelector('.voice-chat-pane');
  check(new URL(b.url()).searchParams.get('chat') === '1', 'reopened with the chat after a reload');
  await b.click('.voice-chat-pane button[aria-label="Close chat"]');
  await b.waitForSelector('.voice-chat-pane', { state: 'detached' });
  check(await b.locator('.member-list').isVisible(), 'closing brings the member list back');
  await b.reload();
  await b.waitForSelector('.voice-view');
  check(!(await b.$('.voice-chat-pane')), 'and stays closed');

  // Carol, on a phone: the lounge's page, then its chat over it, and Back.
  const c = carol.page;
  await c.goto(`${BASE}/guild/${guild.id}/${lounge.id}`);
  await c.waitForSelector('.voice-view');
  await c.tap('.channel-header .voice-chat-button');
  await c.waitForSelector(".voice-chat-pane >> text=I'm in, give me ten minutes");
  const phonePane = await c.locator('.voice-chat-pane').boundingBox();
  const phoneView = c.viewportSize();
  check(phonePane.width >= phoneView.width - 1, 'on a phone the chat covers the voice page');
  await c.tap('.voice-chat-pane #dm-input');
  await c.keyboard.type('Count me in too');
  // (Enter is a new line on a phone.)
  await c.tap('.voice-chat-pane button:has-text("Send")');
  await a.waitForSelector('.voice-chat-pane >> text=Count me in too');
  check(true, "Carol's message reaches Alice");
  await shot(c, 'phone-chat');
  await c.goBack();
  await c.waitForSelector('.voice-chat-pane', { state: 'detached' });
  check(await c.locator('.voice-view-join').isVisible(), 'Back returns to the voice page');
  await shot(c, 'phone-back');

  console.log('voice chat: all good');
} finally {
  await browser.close();
}
