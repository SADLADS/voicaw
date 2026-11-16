// Errors (Errors in docs/client.md): what the app shows when something fails, in words, never
// axios's ("Network Error", "status code 500"). A chat that can't load (500, then refused):
// the error state, Details, Try again loads it. The DM list refused: a card in the sidebar, Try
// again fills it. A message that can't be sent: "Not sent." and the bar, each with the triangle,
// the bar in words. Pinning refused by the server: a toast with its reason. The connection lost
// (the browser offline): the strip after a moment, gone once back. In Light and on a phone too.
//   node e2e/serve.mjs &   then   node e2e/errors.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, BASE, devices, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const refuse = (route) => route.abort('connectionrefused');
const fail500 = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal server error"}' });
const RAW = /Network Error|status code|timeout of/;
const rawText = async (page) => RAW.test(await page.locator('body').innerText());
const setTheme = (page, theme) => page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
const hidePrompts = (page) => page.evaluate(() => document.querySelectorAll('.notification-prompt-close, .notification-prompt button:last-child').forEach((b) => b.click()));

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  await makeFriends(ann, bea);
  const a = ann.page;
  await openChat(bea.page, ann.id);
  await send(bea.page, 'hey ann! are we still on for tonight?');
  await openChat(a, bea.id);
  await a.waitForSelector('text=are we still on');
  await hidePrompts(a);

  // ---- A chat that can't load ----
  await a.route('**/api/dm-messages/**', fail500);
  await a.reload();
  await a.waitForSelector('.error-state');
  check(await a.locator('.error-state-title').innerText() === "Couldn't load your messages", 'a 500 shows the error state, titled');
  check(!(await rawText(a)), "no axios words on the page");
  await a.locator('.error-state-link').click();
  check(/^500 · GET \/dm-messages\/\d+ · /.test(await a.locator('.error-state-details span').innerText()), 'Details: status, request, time');
  await shot(a, 'chat-500-dark');
  await setTheme(a, 'light');
  await shot(a, 'chat-500-light');
  await setTheme(a, 'slack');
  await shot(a, 'chat-500-slack');
  await setTheme(a, 'dark');
  await a.unroute('**/api/dm-messages/**');
  await a.locator('.error-state-button').click();
  await a.waitForSelector('text=are we still on', { timeout: 10000 });
  check(await a.locator('.error-state').count() === 0, 'Try again loads the chat');

  // Refused: the chat comes from this device's offline copy instead (Offline copy, docs/messages.md).
  await a.route('**/api/dm-messages/**', refuse);
  await a.reload();
  await a.waitForSelector('text=are we still on', { timeout: 10000 });
  check(await a.locator('.error-state').count() === 0 && !(await rawText(a)), 'refused: the saved copy shows, no error');
  await a.unroute('**/api/dm-messages/**');

  // ---- The DM list can't load ----
  await a.route('**/api/dms-list', refuse);
  await a.goto(`${BASE}/dm/friends`);
  await a.waitForSelector('#dm-sidebar .inline-error', { timeout: 10000 });
  check((await a.locator('.inline-error-title').innerText()) === "Couldn't load your conversations", 'the DM list says so in the sidebar, on Friends too');
  await shot(a, 'dm-list');
  await a.unroute('**/api/dms-list');
  await a.locator('.inline-error-retry').click();
  await a.locator('#dm-sidebar .dm-user', { hasText: bea.name ?? 'bea' }).first().waitFor({ timeout: 10000 });
  check(await a.locator('.inline-error').count() === 0, 'Try again fills the list');

  // ---- A message that can't be sent ----
  await openChat(a, bea.id);
  await a.waitForSelector('text=are we still on');
  await a.route('**/api/dm-send', refuse);
  await send(a, 'yes! 8pm at the usual place').catch(() => {});
  await a.waitForSelector('.message-unsent');
  check(await a.locator('.message-unsent-label svg').count() === 1, '"Not sent." has the triangle');
  const bar = await a.locator('.composer-error-text').innerText();
  check(bar.startsWith('Message failed to send. Can\'t reach Voicaw'), `the bar says why in words (${bar})`);
  check(await a.locator('.composer-error-text svg').count() === 1, 'the bar has the triangle');
  await shot(a, 'send-failed');
  await a.unroute('**/api/dm-send');
  await a.locator('.message-unsent button', { hasText: 'Retry' }).click();
  await a.waitForFunction(() => !document.querySelector('.message-unsent'), null, { timeout: 10000 });
  await a.locator('.composer-error .reply-close').click().catch(() => {});

  // ---- Pinning refused: a toast with the server's reason ----
  await a.route('**/api/dm-messages/*/pin', (route) => (route.request().method() === 'GET' ? route.continue()
    : route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"A chat can have at most 250 pinned messages. Unpin one first."}' })));
  const row = a.locator('.each-dm-message-wrapper', { hasText: 'are we still on' });
  await row.hover();
  await row.locator('.message-menu .pin-button').click();
  await a.waitForSelector('.toast');
  check((await a.locator('.toast-title').innerText()) === "Couldn't pin that message", 'a toast says what failed');
  check((await a.locator('.toast-text').innerText()).includes('at most 250'), "with the server's reason");
  await a.mouse.move(5, 5);
  await a.waitForTimeout(400); // its fade-in
  await shot(a, 'toast');
  await setTheme(a, 'slack');
  await shot(a, 'toast-slack');
  await setTheme(a, 'dark');
  await a.unroute('**/api/dm-messages/*/pin');
  await a.locator('.toast-close').click();

  // ---- The connection lost ----
  await a.context().setOffline(true);
  await a.waitForSelector('.connection-strip', { timeout: 8000 });
  check((await a.locator('.connection-strip').innerText()).includes("Can't reach Voicaw"), 'the strip shows when the connection goes');
  const stripBox = await a.locator('.connection-strip').boundingBox();
  const pageBox = await a.locator('.main-content-page').boundingBox();
  check(stripBox && pageBox && pageBox.y >= stripBox.y + stripBox.height - 1 && pageBox.y + pageBox.height <= 751, 'the page fits under it');
  await shot(a, 'connection');
  await setTheme(a, 'light');
  await shot(a, 'connection-light');
  await setTheme(a, 'dark');
  await a.context().setOffline(false);
  await a.waitForSelector('.connection-strip', { state: 'detached', timeout: 15000 });
  check(true, 'and goes once back');

  // ---- Phone ----
  const cat = await signUp(browser, 'cat', { ...devices['Pixel 7'] });
  await makeFriends(cat, bea);
  const p = cat.page;
  await p.route('**/api/dm-messages/**', fail500);
  await openChat(p, bea.id).catch(() => {});
  await p.waitForSelector('.error-state');
  await hidePrompts(p);
  const box = await p.locator('.error-state').boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 413, 'the error state fits a phone');
  await shot(p, 'phone-chat');
  console.log('errors: ok');
} catch (err) {
  console.error('errors: FAILED', err.stack.split('\n').slice(0, 4).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
