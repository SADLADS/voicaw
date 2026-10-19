// Who's in a voice channel stays right on a phone whose connection was away (docs/realtime.md):
// people who left while it was gone don't stay shown under the channel until a restart.
//   node e2e/serve.mjs &   then   node e2e/voicecatchup.mjs [screenshot dir]
// Dan (a phone) has the guild open; his websocket goes through a stand-in (Playwright's
// routeWebSocket).
// 1. It drops Bob's leave, then the socket closes and the app reconnects (an app back from the
//    background): Bob is gone from the channel.
// 2. The socket goes dead without closing (a phone asleep or on another network: nothing either
//    way, not even the pong), Bob leaves, the app is hidden and shown again: it gives the socket
//    up after 5 s with no pong, connects again, and Bob is gone.
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const bob = await signUp(browser, 'bob');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const b = bob.page;
  const d = dan.page;

  let deafToVoice = false;
  const dead = new Set();
  const sockets = [];
  await d.context().routeWebSocket(/\/ws|:\d+\/?$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((message) => {
      if (!dead.has(ws)) server.send(message);
    });
    server.onMessage((message) => {
      if (dead.has(ws)) return;
      if (deafToVoice && String(message).includes('"guild_voice_state"')) return;
      ws.send(message);
    });
  });

  await b.click('button[aria-label="Add a guild"]');
  await b.fill('#new-guild-name', 'Gaming Tuesday');
  await b.click('button:has-text("Create")');
  await b.waitForSelector('#dm-input');
  await b.click('.guild-header-button');
  await b.click('text=Create Channel');
  await b.click('label:has-text("Voice")');
  await b.fill('#channel-name', 'Lounge');
  await b.click('button:has-text("Create channel")');
  await b.waitForSelector('.voice-view-join');
  await b.click('.guild-header-button');
  await b.click('text=Invite People');
  await b.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await b.inputValue('#invite-link');
  await b.keyboard.press('Escape');

  await d.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await d.click('button:has-text("Accept invite")');
  await d.waitForSelector('#dm-input');
  if (!sockets.length) throw new Error("Dan's websocket didn't go through the stand-in");
  // Back to the channel list (it opened on a chat).
  await d.goBack();
  await d.waitForSelector('.guild-channel-link:has-text("lounge")');

  const bobInLounge = `.voice-member[data-user-id="${bob.id}"]`;
  const join = async () => {
    await b.click('.guild-channel-link:has-text("lounge")');
    await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
    await d.waitForSelector(bobInLounge, { timeout: 10000 });
  };
  const leave = async () => {
    await b.click('.voice-bar-leave');
    await b.waitForSelector('.voice-bar-status', { state: 'detached', timeout: 10000 });
    await d.waitForTimeout(1500);
  };
  const setVisible = (visible) => d.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);

  // 1. Bob's leave missed, then a reconnect.
  await join();
  await shot(d, '01-dan-sees-bob');
  deafToVoice = true;
  await leave();
  if (!(await d.$(bobInLounge))) throw new Error('the stand-in delivered the leave');
  await shot(d, '02-dan-missed-the-leave');
  deafToVoice = false;
  const before = sockets.length;
  await sockets.at(-1).close({ code: 1006 });
  await d.waitForSelector(bobInLounge, { state: 'detached', timeout: 10000 });
  if (sockets.length <= before) throw new Error("the page didn't reconnect");
  await shot(d, '03-dan-after-reconnect');
  console.log('voicecatchup: ok (missed leave, then a reconnect)');

  // 2. A socket that looks open but is dead, then the app comes back to the front.
  await join();
  const zombie = sockets.at(-1);
  dead.add(zombie);
  await leave();
  if (!(await d.$(bobInLounge))) throw new Error('the dead socket delivered the leave');
  await setVisible(false);
  await d.waitForTimeout(500);
  const started = Date.now();
  await setVisible(true);
  await d.waitForSelector(bobInLounge, { state: 'detached', timeout: 15000 });
  if (sockets.at(-1) === zombie) throw new Error('no new socket');
  console.log(`voicecatchup: ok (dead socket given up, Bob gone ${((Date.now() - started) / 1000).toFixed(1)} s after showing)`);
  await shot(d, '04-dan-after-dead-socket');

  // Live again on the new socket.
  await join();
  await leave();
  await d.waitForSelector(bobInLounge, { state: 'detached', timeout: 5000 });
  console.log('voicecatchup: ok (live again)');
} catch (err) {
  console.error('voicecatchup: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
