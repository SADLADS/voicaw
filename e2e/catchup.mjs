// Catching up (docs/messages.md): an open chat gets the messages its websocket missed.
//   node e2e/serve.mjs &   then   node e2e/catchup.mjs
// Bob's websocket goes through a stand-in (Playwright's routeWebSocket) that can drop the
// server's DMs, as a socket that's gone without the page knowing (a phone asleep) does.
// 1. It drops one, then the socket closes and the app reconnects: the message shows in the
//    open chat (the socket's identify fetches the newest page).
// 2. It drops one, then Bob's app is hidden a while and shown again (tapping a notification):
//    the message shows.
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');

  let deaf = false;
  const sockets = [];
  await bob.page.context().routeWebSocket(/\/ws|:\d+\/?$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (deaf && String(message).includes('"new_dm"')) return;
      ws.send(message);
    });
  });
  await bob.page.reload();
  await bob.page.waitForSelector('#dm-main', { timeout: 20000 });
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await send(alice.page, 'first, live');
  await bob.page.waitForSelector('text=first, live', { timeout: 10000 });
  if (!sockets.length) throw new Error("Bob's websocket didn't go through the stand-in");

  const missed = async (text) => {
    deaf = true;
    await send(alice.page, text);
    await alice.page.waitForSelector(`text=${text}`);
    await bob.page.waitForTimeout(1500);
    if (await bob.page.$(`text=${text}`)) throw new Error('the deaf socket delivered it');
    deaf = false;
  };
  const shownOnce = async (text) => {
    await bob.page.waitForSelector(`text=${text}`, { timeout: 15000 });
    const count = await bob.page.locator(`text=${text}`).count();
    if (count !== 1) throw new Error(`"${text}" shown ${count} times`);
  };

  // 1. Missed, then a reconnect.
  await missed('missed, then a reconnect');
  await sockets.at(-1).close({ code: 1006 });
  await shownOnce('missed, then a reconnect');
  if (sockets.length < 2) throw new Error("the page didn't reconnect");
  console.log('catchup: ok (reconnect)');

  // 2. Missed, then the app comes back to the front.
  await missed('missed, then back from hidden');
  const setVisible = (visible) => bob.page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
  await setVisible(false);
  await bob.page.waitForTimeout(5500);
  await setVisible(true);
  await shownOnce('missed, then back from hidden');
  console.log('catchup: ok (back from hidden)');

  // Live messages still arrive once.
  await send(alice.page, 'live again');
  await shownOnce('live again');
  console.log('catchup: ok (live again)');
} catch (err) {
  console.error('catchup: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
