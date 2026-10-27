// Pinned messages: pinning from the hover menu (DM), the pin showing live for the other person,
// the pinned list (decrypted on the device) and jumping to a message not loaded yet; in a
// guild only with Pin Messages; in a group DM; on a phone (long press, full-screen list). Each pin
// also posts a "X pinned a message" row: "a message" jumps to it, "See all pinned messages" opens
// the list.
//   node e2e/serve.mjs &   then   node e2e/pins.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices, makeFriends } from './helpers.mjs';

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

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const content = (page, text) => page.locator('.dm-message-content', { hasText: exactly(text) });
const row = (page, text) => page.locator('.each-dm-message-wrapper', { has: content(page, text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });

// Hovers a message and clicks its pin button.
async function pinFromMenu(page, text) {
  await row(page, text).hover();
  await row(page, text).locator('.message-menu .pin-button').click();
}

// Whether the message's row shows the pin marker.
const isPinned = (page, text) => row(page, text).locator('.message-pinned').count().then((n) => n > 0);

async function waitPinned(page, text, pinned = true) {
  await page.waitForFunction(([t, want]) => {
    const r = [...document.querySelectorAll('.each-dm-message-wrapper')]
      .find((el) => el.querySelector('.dm-message-content')?.textContent === t);
    return r && Boolean(r.querySelector('.message-pinned')) === want;
  }, [text, pinned], { timeout: 10000 });
}

async function longPress(page, locator) {
  const box = await locator.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 20);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  // Groups are made from friends.
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;

  // ---- DMs (computer) ----
  console.log('DM');
  await openChat(a, bob.id);
  await send(a, 'the plan is in here');
  await waitText(a, 'the plan is in here');
  await pinFromMenu(a, 'the plan is in here');
  await waitPinned(a, 'the plan is in here');
  check(true, 'alice pinned her message from the hover menu');
  // Enough after it that bob's first page doesn't include it (a page is 50, and the list preloads up to 1.5 screens above).
  for (let i = 1; i <= 130; i++) await send(a, `filler ${i}`);
  await waitText(a, 'filler 130');

  await openChat(b, alice.id);
  await waitText(b, 'filler 130');
  check(await row(b, 'the plan is in here').count() === 0, "bob's chat hasn't loaded the pinned message yet");
  await b.click('.pins-button');
  const panel = b.locator('.pins-panel');
  await panel.locator('.pinned-message:has-text("the plan is in here")').waitFor();
  check(true, 'the pinned list shows it, decrypted');
  await shot(b, '01-dm-pins-list');
  await panel.locator('.pinned-message-jump').click();
  await row(b, 'the plan is in here').waitFor({ timeout: 20000 });
  const inView = await row(b, 'the plan is in here').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = document.querySelector('.message-scroller').getBoundingClientRect();
    return r.top >= s.top && r.bottom <= s.bottom;
  });
  check(inView, 'Jump loaded older history and scrolled to it');
  check(await row(b, 'the plan is in here').evaluate((el) => el.classList.contains('jump-highlight')), 'and highlights it');
  await shot(b, '02-dm-jumped');
  await b.keyboard.press('Escape');
  check(await b.locator('.pins-panel').count() === 0, 'Escape closes the list');

  // Bob pins the newest; alice sees it live.
  await b.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight; });
  await pinFromMenu(b, 'filler 130');
  await waitPinned(a, 'filler 130');
  check(true, "bob's pin shows for alice live");
  const notice = a.locator('.pin-notice').last();
  await notice.waitFor({ timeout: 10000 });
  const noticeText = await notice.locator('span').first().textContent();
  check(noticeText === `${bob.name} pinned a message to this chat. See all pinned messages.`, `and a "pinned a message" row (${noticeText})`);
  await shot(a, '03a-pin-row');
  await a.evaluate(() => { document.querySelector('.message-scroller').scrollTop = 0; });
  await notice.locator('button:has-text("a message")').click();
  await a.waitForFunction(() => [...document.querySelectorAll('.each-dm-message-wrapper.jump-highlight')]
    .some((el) => el.querySelector('.dm-message-content')?.textContent === 'filler 130'), null, { timeout: 10000 });
  check(true, '"a message" jumps to the pinned message and flashes it');
  await notice.locator('button:has-text("See all pinned messages")').click();
  await a.locator('.pins-panel .pinned-message').nth(1).waitFor();
  const order = await a.locator('.pins-panel .pinned-message .dm-message-content').allTextContents();
  check(order[0] === 'filler 130' && order[1] === 'the plan is in here', `newest pin first (${order.join(' | ')})`);
  await shot(a, '03-dm-two-pins');
  // Unpinning from the list: gone for both.
  await a.locator('.pins-panel .pinned-message:has-text("filler 130") button[aria-label="Unpin"]').click();
  await waitPinned(b, 'filler 130', false);
  check(await a.locator('.pins-panel .pinned-message').count() === 1, 'unpinning from the list removes it (for both)');
  await a.mouse.click(5, 300); // a click elsewhere closes it
  check(await a.locator('.pins-panel').count() === 0, 'a click outside closes the list');

  // ---- Guild: only with Pin Messages ----
  console.log('guild');
  const guild = await api(a, 'POST', '/guilds', { name: 'Pins' });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  for (const p of [a, b]) {
    await p.goto(`${BASE}/guild/${guild.id}`);
    await p.waitForSelector('#dm-input');
  }
  await send(b, 'rules: be nice');
  await waitText(a, 'rules: be nice');
  await row(b, 'rules: be nice').hover();
  check(await row(b, 'rules: be nice').locator('.pin-button').count() === 0, 'a member without Pin Messages gets no pin button');
  await pinFromMenu(a, 'rules: be nice');
  await waitPinned(b, 'rules: be nice');
  check(true, "the owner pins; bob sees it");
  await b.locator('.pin-notice').last().waitFor({ timeout: 10000 });
  check((await b.locator('.pin-notice').last().textContent()).startsWith(`${alice.name} pinned a message`), 'with its "pinned" row in the channel');
  await b.click('.pins-button');
  await b.locator('.pins-panel .pinned-message:has-text("rules: be nice")').waitFor();
  check(await b.locator('.pins-panel button[aria-label="Unpin"]').count() === 0, 'bob can see the list but not unpin');
  await shot(b, '04-guild-member-list');
  await b.keyboard.press('Escape');
  const role = await api(a, 'POST', `/guilds/${guild.id}/roles`, { name: 'Pinners', permissions: 1 << 15 });
  await api(a, 'PUT', `/guilds/${guild.id}/members/${bob.id}/roles`, { roleIds: [role.id] });
  await b.waitForFunction(() => true);
  await row(b, 'rules: be nice').hover();
  await row(b, 'rules: be nice').locator('.pin-button').waitFor({ timeout: 10000 });
  check(true, 'given a role with Pin Messages, bob gets the button');
  await row(b, 'rules: be nice').locator('.pin-button').click();
  await waitPinned(a, 'rules: be nice', false);
  check(true, 'and can unpin');

  // ---- Group DM ----
  console.log('group');
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Pinners');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupUrl = a.url();
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await send(a, 'group plan');
  await waitText(a, 'group plan');
  await b.goto(groupUrl);
  await waitText(b, 'group plan', 20000);
  await pinFromMenu(b, 'group plan');
  await waitPinned(a, 'group plan');
  check(true, 'a group member pins; the others see it live');
  await a.click('.pins-button');
  await a.locator('.pins-panel .pinned-message:has-text("group plan")').waitFor();
  check(true, 'the group list shows it, decrypted');
  await shot(a, '05-group-list');
  await a.keyboard.press('Escape');

  // ---- Phone ----
  console.log('phone');
  await c.goto(groupUrl);
  await waitText(c, 'group plan', 20000);
  check(await isPinned(c, 'group plan'), 'carol (phone) sees the pin');
  await longPress(c, row(c, 'group plan'));
  await c.waitForSelector('.action-sheet');
  await shot(c, '06-phone-sheet');
  await c.click('.action-sheet-item:has-text("Unpin message")');
  await waitPinned(a, 'group plan', false);
  check(true, 'long press → Unpin message works');
  await longPress(c, row(c, 'group plan'));
  await c.click('.action-sheet-item:has-text("Pin message")');
  await waitPinned(a, 'group plan');
  check(true, 'long press → Pin message works');
  const phoneNotice = c.locator('.pin-notice').last();
  await phoneNotice.waitFor({ timeout: 10000 });
  const noticeBox = await phoneNotice.boundingBox();
  check(noticeBox.x >= 0 && noticeBox.x + noticeBox.width <= c.viewportSize().width, 'the "pinned" row fits the phone');
  await shot(c, '06a-phone-pin-row');
  await a.locator('.pin-notice').last().waitFor();
  check(await a.locator('.pin-notice').count() >= 2, 'group pins post rows too');
  await c.click('.pins-button');
  await c.locator('.pins-panel.mobile .pinned-message:has-text("group plan")').waitFor();
  const full = await c.locator('.pins-panel').boundingBox();
  const viewport = c.viewportSize();
  check(full.width === viewport.width && full.height >= viewport.height - 1, 'the list is full screen on a phone');
  await shot(c, '07-phone-list');
  await c.click('.pins-panel .pinned-message-jump');
  check(await c.locator('.pins-panel').count() === 0, 'Jump closes it on a phone');
  console.log('pins: ok');
} catch (err) {
  console.error('pins: FAILED', err.message.split('\n')[0]);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      console.error(`  ${page.url()}:`, (await page.locator('.dm-message-content').allTextContents().catch(() => [])).slice(-3));
    }
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
