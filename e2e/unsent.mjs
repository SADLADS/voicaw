// Messages that couldn't be sent: the connection failing before the message reached the server
// shows it "Not sent." with Retry and Delete, still there after going to another chat and back;
// Retry sends it once. The answer lost after the server saved it (connection gone, then back):
// the app finds it arrived, nothing left unsent and no second copy. Delete. A guild channel,
// and a phone.
//   node e2e/serve.mjs &   then   node e2e/unsent.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, makeFriends, send } from './helpers.mjs';

const shots = process.argv[2];
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const clickDm = async (page, name) => {
  await page.click(`.dm-user:has-text("${name}")`);
  await page.waitForSelector(`#dm-input[aria-label="Message ${name}"]`);
};
const count = (page, text) => page.locator('.dm-message-content', { hasText: text }).count();
// The next send request fails: before reaching the server ('before'), or after it saved the
// message, its answer lost ('after', which also takes the page offline for a moment).
const failNext = (page, pattern, when) => {
  let done = false;
  return page.route(pattern, async (route) => {
    if (done || route.request().method() !== 'POST') return route.fallback();
    done = true;
    if (when === 'after') {
      await route.fetch();
      await page.context().setOffline(true);
    }
    await route.abort('internetdisconnected');
  });
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  await openChat(b, alice.id);
  await openChat(a, bob.id);

  // Never reached the server.
  await failNext(a, '**/api/dm-send', 'before');
  await send(a, 'first try');
  await a.waitForSelector('.message-unsent');
  check((await a.textContent('.message-unsent')).includes('Not sent.'), '"Not sent." under it, with Retry and Delete');
  check(await a.$eval('.dm-message.failed .dm-message-content', (el) => getComputedStyle(el).color) !== 'rgb(0, 0, 0)', 'its text is red');
  if (shots) await a.screenshot({ path: `${shots}/unsent-dm.png` });
  check(await a.$eval('#dm-input', (el) => el.innerText.trim()) === '', 'the box is empty (the message is in the chat)');

  await clickDm(a, carol.name);
  check(!(await a.$('.message-unsent')), "not in Carol's chat");
  await a.click('a[aria-label="Settings"]');
  await a.waitForSelector('#dm-input', { state: 'detached' });
  await a.click('a[aria-label="Direct Messages"]');
  await clickDm(a, bob.name);
  await a.waitForSelector('.message-unsent', { timeout: 5000 });
  check(await count(a, 'first try') === 1, 'back with Bob after Settings: still there, unsent');

  await a.click('.message-unsent button:has-text("Retry")');
  await b.waitForSelector('.dm-message-content:has-text("first try")', { timeout: 10000 });
  await a.waitForSelector('.message-unsent', { state: 'detached', timeout: 10000 });
  await a.waitForTimeout(500);
  check(await count(b, 'first try') === 1, 'Retry: Bob gets it once');
  check(await count(a, 'first try') === 1 && !(await a.$('.dm-message.failed')), 'Retry: sent on Alice\'s side');

  // Saved, but the answer lost and the connection gone for a moment.
  await failNext(a, '**/api/dm-send', 'after');
  await send(a, 'did this arrive');
  await b.waitForSelector('.dm-message-content:has-text("did this arrive")', { timeout: 10000 });
  await a.waitForTimeout(1000);
  await a.context().setOffline(false);
  // Back online, the chat catches up and finds it.
  await a.waitForFunction(() => !document.querySelector('.message-unsent'), null, { timeout: 20000 });
  await a.waitForTimeout(1000);
  check(await count(a, 'did this arrive') === 1, 'answer lost: once on Alice\'s side, not unsent');
  check(await count(b, 'did this arrive') === 1, 'answer lost: Bob has it once');

  // Retry of one whose answer was lost while it's still shown: the server gives the saved one back.
  let lost = false;
  await a.route('**/api/dm-send', async (route) => {
    if (lost) return route.fallback();
    lost = true;
    await route.fetch();
    await route.abort('internetdisconnected');
  });
  // Our own websocket echo would clear it: the socket (proxied, after a reload) drops what the
  // server says meanwhile.
  let dropEvents = false;
  await a.routeWebSocket(/\/api\/socket|:\d+\/?$|\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => { if (!dropEvents) ws.send(message); });
  });
  await a.reload();
  await a.waitForSelector('#dm-input');
  await a.waitForTimeout(1000);
  dropEvents = true;
  await send(a, 'retry me safely');
  await a.waitForSelector('.message-unsent', { timeout: 10000 });
  await a.waitForTimeout(300);
  dropEvents = false;
  await a.click('.message-unsent button:has-text("Retry")');
  await a.waitForSelector('.message-unsent', { state: 'detached', timeout: 10000 });
  await a.waitForTimeout(1000);
  check(await count(b, 'retry me safely') === 1, 'Retry after a lost answer: Bob still has it once');
  check(await count(a, 'retry me safely') === 1, 'Retry after a lost answer: once on Alice\'s side');

  // Delete.
  await failNext(a, '**/api/dm-send', 'before');
  await send(a, 'forget this');
  await a.waitForSelector('.message-unsent');
  await a.click('.message-unsent button:has-text("Delete")');
  await a.waitForSelector('.message-unsent', { state: 'detached' });
  check(await count(a, 'forget this') === 0, 'Delete: gone, without asking');

  // A guild channel.
  await a.reload();
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Unsent Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.waitForSelector('#dm-input');
  await failNext(a, '**/api/channels/*/messages', 'before');
  await send(a, 'channel hello');
  await a.waitForSelector('.message-unsent');
  await a.click('a[aria-label="Direct Messages"]');
  await a.click('.rail-guild[aria-label="Unsent Guild"]');
  await a.waitForSelector('.message-unsent', { timeout: 5000 });
  check(true, 'channel: still unsent after leaving the guild and back');
  await a.click('.message-unsent button:has-text("Retry")');
  await a.waitForSelector('.message-unsent', { state: 'detached', timeout: 10000 });
  check(await count(a, 'channel hello') === 1, 'channel: Retry sends it');

  // A phone.
  const phone = await signUp(browser, 'phoneuser', { ...devices['Pixel 7'] });
  await makeFriends(phone, bob);
  const p = phone.page;
  await openChat(p, bob.id);
  await failNext(p, '**/api/dm-send', 'before');
  // Enter is a new line on a phone: Send.
  await p.click('#dm-input');
  await p.keyboard.type('from my phone');
  await p.tap('button.send-button');
  await p.waitForSelector('.message-unsent');
  const box = await p.$eval('.message-unsent', (el) => {
    const r = el.getBoundingClientRect();
    return { right: r.right, width: window.innerWidth };
  });
  check(box.right <= box.width, 'phone: Not sent / Retry / Delete fit the screen');
  if (shots) await p.screenshot({ path: `${shots}/unsent-phone.png` });
  await p.tap('.message-unsent button:has-text("Retry")');
  await p.waitForSelector('.message-unsent', { state: 'detached', timeout: 10000 });
  check(true, 'phone: Retry sends it');
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
