// Reacting and replying to "poll ended" rows: a DM poll ended by its author, then on the row
// (computer) the hover menu's quick reaction (live for the other person, a phone), the
// right-click menu (reactions, Reply; no Edit, Pin, Delete), Reply from the hover menu with the
// reply's snippet reading "Poll results" (also after a reload, from the server), the phone's
// long-press sheet (Reply, no Delete) replying from there; then the same in a guild channel.
//   node e2e/serve.mjs &   then   node e2e/pollendreplies.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`ok: ${what}`);
};

async function createPoll(page, question, answers) {
  await page.click('.attach-button');
  await page.click('.composer-add-item:has-text("Create poll")');
  await page.fill('#poll-question', question);
  for (let i = 0; i < answers.length; i++) await page.fill(`textarea[aria-label="Answer ${i + 1}"]`, answers[i]);
  await page.click('.vc-dialog button:has-text("Post")');
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}
const pollOf = (page, question) => page.locator(`.poll:has(.poll-question:text-is("${question}"))`);
async function endPoll(page, question) {
  await pollOf(page, question).locator('button:text-is("End poll")').click();
  await page.click('.vc-dialog button.btn-danger:has-text("End poll")');
}
// The "poll ended" row for `question` (the whole row, menus and reactions included).
const row = (page, question) => page.locator(`.poll-end-row:has(.poll-end strong:text-is("${question}"))`);
const menuItems = (page) => page.$$eval('.context-menu [role="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));

async function longPress(page, locator) {
  const box = await locator.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + 12 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// The reply whose text is `text`, and that its snippet reads "Poll results".
async function checkReplySnippet(page, text, where) {
  const reply = page.locator(`.each-dm-message-wrapper:has(.dm-message-content:has-text("${text}")):has(.reply-preview)`);
  await reply.waitFor({ timeout: 10000 });
  const snippet = (await reply.locator('.reply-preview').textContent()).trim();
  check(snippet === 'Poll results' && await reply.locator('.reply-poll-end-icon').count() === 1, `${where}: the reply's snippet reads "Poll results" with the poll icon (${snippet})`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await openChat(a, bob.id);
  await openChat(b, alice.id);

  await createPoll(a, 'Lunch?', ['Pizza', 'Soup']);
  await pollOf(b, 'Lunch?').waitFor({ timeout: 10000 });
  await endPoll(a, 'Lunch?');
  await row(a, 'Lunch?').waitFor({ timeout: 10000 });
  await row(b, 'Lunch?').waitFor({ timeout: 10000 });

  // Computer: hovering shows the menu with quick reactions and Reply, nothing else.
  await row(a, 'Lunch?').hover();
  const menu = row(a, 'Lunch?').locator('.message-menu');
  await menu.waitFor();
  check(await menu.locator('.quick-reaction-button').count() === 3, 'hovering the row shows three quick reactions');
  check(await menu.locator('[data-icon="reply"]').count() === 1, '…and Reply');
  check(await menu.locator('.trash-button, .pin-button, [data-icon="pen-to-square"]').count() === 0, '…and no Delete, Pin or Edit');
  await shot(a, '1-hover');
  await menu.locator('.quick-reaction-button').first().click();
  await row(a, 'Lunch?').locator('.reaction-chip:not(.reaction-add)').first().waitFor({ timeout: 10000 });
  await row(b, 'Lunch?').locator('.reaction-chip:not(.reaction-add)').first().waitFor({ timeout: 10000 });
  check(true, 'a reaction on the row shows for both (decrypted on the phone)');

  // Right-click: reactions and Reply only.
  await row(a, 'Lunch?').locator('.poll-end-icon').click({ button: 'right' });
  await a.waitForSelector('.context-menu');
  const items = await menuItems(a);
  check(items.includes('Reply') && items.includes('Add Reaction') && items.includes('View Reactions'), `right-click offers reactions and Reply (${items.join(' | ')})`);
  check(!items.some((i) => /Edit|Pin|Delete|Copy|Forward|Thread/.test(i)), 'right-click offers nothing that changes or removes the row');
  await shot(a, '2-menu');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.context-menu', { state: 'detached' });

  // Reply from the hover menu.
  await row(a, 'Lunch?').hover();
  await row(a, 'Lunch?').locator('.message-menu [data-icon="reply"]').click();
  await a.waitForSelector('.reply-bar, :text("Replying to")');
  check(await row(a, 'Lunch?').evaluate((el) => el.classList.contains('replying')), 'the row is marked as being replied to');
  await a.keyboard.type('Pizza it is');
  await a.keyboard.press('Enter');
  await checkReplySnippet(a, 'Pizza it is', 'computer');
  await checkReplySnippet(b, 'Pizza it is', 'phone, live');
  await b.reload();
  await row(b, 'Lunch?').waitFor({ timeout: 20000 });
  await checkReplySnippet(b, 'Pizza it is', 'phone, after a reload');
  await shot(a, '3-reply');

  // Phone: holding the row opens its sheet: Reply, no Delete.
  await longPress(b, row(b, 'Lunch?').locator('.poll-end'));
  await b.waitForSelector('.action-sheet');
  const sheet = await b.$$eval('.action-sheet-items button', (els) => els.map((e) => e.textContent.trim()));
  check(sheet.includes('Reply') && !sheet.some((i) => /Edit|Pin|Delete|Copy|Forward/.test(i)), `holding the row (phone) offers Reply, nothing that changes it (${sheet.join(' | ')})`);
  check(await b.locator('.action-sheet-reaction').count() > 0, '…and quick reactions');
  await shot(b, '4-sheet-phone');
  await b.tap('.action-sheet-items button:text-is("Reply")');
  await b.waitForSelector(':text("Replying to")');
  await b.keyboard.type('Soup next time');
  await b.tap('button.send-button'); // Enter is a new line on phones
  await checkReplySnippet(a, 'Soup next time', 'reply from the phone');
  await shot(b, '5-reply-phone');

  // A guild channel: the same, with its own server-side rows.
  const guild = await a.evaluate(async () => {
    const h = { 'X-Voicaw-Session': JSON.parse(localStorage.getItem('login')).sid, 'Content-Type': 'application/json' };
    const g = await (await fetch('/api/guilds', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Polls' }) })).json();
    return { id: g.id, channel: g.channels[0].id };
  });
  await a.goto(`${BASE}/guild/${guild.id}/${guild.channel}`);
  await a.waitForSelector('#dm-input');
  await createPoll(a, 'Movie?', ['Yes', 'No']);
  await endPoll(a, 'Movie?');
  await row(a, 'Movie?').waitFor({ timeout: 10000 });
  await row(a, 'Movie?').hover();
  await row(a, 'Movie?').locator('.message-menu .quick-reaction-button').first().click();
  await row(a, 'Movie?').locator('.reaction-chip:not(.reaction-add)').first().waitFor({ timeout: 10000 });
  await row(a, 'Movie?').hover();
  await row(a, 'Movie?').locator('.message-menu [data-icon="reply"]').click();
  await a.keyboard.type('Popcorn ready');
  await a.keyboard.press('Enter');
  await checkReplySnippet(a, 'Popcorn ready', 'guild');
  await a.reload();
  await row(a, 'Movie?').locator('.reaction-chip:not(.reaction-add)').first().waitFor({ timeout: 20000 });
  await checkReplySnippet(a, 'Popcorn ready', 'guild, after a reload');
  await shot(a, '6-guild');
  console.log('pollendreplies: ok');
} catch (err) {
  console.error('pollendreplies: FAILED', err.message.split('\n')[0]);
  if (shots) for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: `${shots}/fail-${browser.contexts().indexOf(p.context())}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
