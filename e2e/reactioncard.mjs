// Who reacted: hovering a reaction shows ":+1: reacted by A, B, C and N others" over it;
// clicking that opens the breakdown (a tab per emoji, who reacted with it, your own removable);
// on a phone, holding a reaction opens it (not the message's actions); light theme.
//   node e2e/serve.mjs &   then   node e2e/reactioncard.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { BASE, launchChrome, signUp, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const chip = (page, emoji) => page.locator(`.message-reactions [data-reaction="${emoji}"]`);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const others = [];
  for (const name of ['bob', 'carol', 'dave', 'erin']) others.push(await signUp(browser, name));
  const frank = await signUp(browser, 'frank', devices['Pixel 7']);

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Reactors' });
  const general = guild.channels[0];
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  for (const u of [...others, frank]) await api(u.page, 'POST', `/invites/${invite.code}`);

  const msg = await api(alice.page, 'POST', `/channels/${general.id}/messages`, { content: 'react to this' });
  for (const u of others) await api(u.page, 'POST', `/guild-messages/${msg.id}/reactions`, { emoji: '👍' });
  await api(frank.page, 'POST', `/guild-messages/${msg.id}/reactions`, { emoji: '👍' });
  await api(others[0].page, 'POST', `/guild-messages/${msg.id}/reactions`, { emoji: '😂' });
  await api(alice.page, 'POST', `/guild-messages/${msg.id}/reactions`, { emoji: '😂' });
  for (const u of others) await u.page.context().close();

  console.log('computer');
  const a = alice.page;
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await chip(a, '👍').waitFor({ timeout: 20000 });
  check(await chip(a, '👍').getAttribute('title') === null, 'no native tooltip on the chip any more');

  await chip(a, '👍').hover();
  const card = a.locator('.reaction-card');
  await card.waitFor({ timeout: 5000 });
  const text = (await card.textContent()).trim();
  const [b, c, d] = others.map((u) => u.name);
  check(text === `:+1: reacted by ${b}, ${c}, ${d} and 2 others`, `hover card: "${text}"`);
  const chipBox = await chip(a, '👍').boundingBox();
  const cardBox = await card.boundingBox();
  check(cardBox.y + cardBox.height <= chipBox.y && chipBox.y - (cardBox.y + cardBox.height) < 12, 'sits just above the chip');
  const cardMid = cardBox.x + cardBox.width / 2;
  check(cardBox.x >= 8 && Math.abs(cardMid - (chipBox.x + chipBox.width / 2)) < 2 || cardBox.x === 8, 'centred on it (or kept on screen)');
  const names = await card.locator('strong').count();
  check(names === 3, 'three names, in bold');
  await shot(a, '01-hover-card');

  // The pointer can travel from the chip onto the card without it vanishing.
  await a.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y - 3);
  await a.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, { steps: 4 });
  await a.waitForTimeout(300);
  check(await card.count() === 1, 'moving onto the card keeps it');

  await chip(a, '😂').hover();
  await a.waitForFunction(() => document.querySelector('.reaction-card')?.textContent.includes(':joy:'));
  const joyText = (await card.textContent()).trim();
  check(joyText === `:joy: reacted by ${b} and ${alice.name}`, `another chip: "${joyText}"`);

  await a.mouse.move(5, 5);
  await card.waitFor({ state: 'detached', timeout: 2000 });
  check(true, 'leaving hides it');

  await chip(a, '👍').hover();
  await card.waitFor();
  await card.click();
  const dialog = a.locator('.vc-dialog.reactions-dialog');
  await dialog.waitFor();
  const tabs = await dialog.locator('[role="tab"]').evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('aria-selected')]));
  check(JSON.stringify(tabs) === JSON.stringify([[':+1:: 5 reactions', 'true'], [':joy:: 2 reactions', 'false']]), `breakdown tabs: ${JSON.stringify(tabs)}`);
  const list = await dialog.locator('[role="tabpanel"] li').allTextContents();
  check(list.length === 5 && list[0] === b && list[4] === frank.name, `who reacted 👍: ${list.join(', ')}`);
  check(await dialog.locator('[role="tabpanel"] li img').count() === 5, 'with their pictures');
  check(await card.count() === 0, 'the card goes when the breakdown opens');
  await shot(a, '02-breakdown');

  await dialog.locator('[role="tab"]').nth(1).click();
  const joyList = await dialog.locator('[role="tabpanel"] li').allTextContents();
  check(joyList[1] === `${alice.name} (you)×`, `😂 tab: ${joyList.join(', ')}`);
  // Right-clicking in it isn't the message's right-click.
  await dialog.locator('[role="tabpanel"] li').first().click({ button: 'right' });
  check(await a.locator('.context-menu').count() === 0, "right-clicking in it doesn't open the message's menu");
  await a.keyboard.press('Escape');
  await a.waitForTimeout(100);
  if (await dialog.count() === 0) {
    await chip(a, '😂').hover();
    await card.waitFor();
    await card.click();
    await dialog.locator('[role="tab"]').nth(1).click();
  }
  await dialog.locator('button[aria-label="Remove your reaction"]').click();
  await a.waitForFunction(() => document.querySelectorAll('.reactions-dialog [role="tabpanel"] li').length === 1);
  check(await chip(a, '😂').getAttribute('aria-pressed') === 'false', 'removing your own takes it off the message');
  await a.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // The other theme (dark is the default).
  await a.emulateMedia({ colorScheme: 'light' });
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await chip(a, '👍').hover();
  await card.waitFor();
  await shot(a, '03-hover-light');
  await a.mouse.move(5, 5);

  console.log('phone');
  const f = frank.page;
  await f.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await chip(f, '👍').waitFor({ timeout: 20000 });
  check(await f.locator('.reaction-card').count() === 0, 'no hover card on a phone');
  const box = await chip(f, '👍').boundingBox();
  const cdp = await f.context().newCDPSession(f);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await f.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await f.locator('.vc-dialog.reactions-dialog').waitFor({ timeout: 5000 });
  check(true, 'holding a reaction opens the breakdown');
  check(await f.locator('.action-sheet').count() === 0, "and not the message's action sheet");
  check(await chip(f, '👍').getAttribute('aria-pressed') === 'true', "and doesn't toggle the reaction");
  const fd = await f.locator('.vc-dialog.reactions-dialog').boundingBox();
  const vw = f.viewportSize().width;
  check(fd.x >= 0 && fd.x + fd.width <= vw, 'fits the phone');
  const flist = await f.locator('.reactions-dialog [role="tabpanel"] li').allTextContents();
  check(flist.at(-1) === `${frank.name} (you)×`, 'you, removable, in the list');
  await shot(f, '04-phone-breakdown');
  // A tap still toggles.
  await f.locator('.reactions-dialog .vc-dialog-close').tap();
  await f.locator('.reactions-dialog').waitFor({ state: 'detached' });
  await chip(f, '😂').tap();
  await f.waitForFunction(() => document.querySelector('.message-reactions [aria-pressed="true"][data-reaction="😂"]'));
  check(true, 'a tap still reacts');

  console.log('reactioncard: ok');
} catch (err) {
  console.error('reactioncard: FAILED', err.message.split('\n')[0]);
  for (const ctx of browser.contexts()) for (const [i, p] of ctx.pages().entries()) await shot(p, `failed-${browser.contexts().indexOf(ctx)}-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
