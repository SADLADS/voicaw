// Polls in a real browser: made from the + menu (with an answer's emoji); picking answers,
// then Vote (live, encrypted DM, phone); Show results / Back to vote / Remove vote; who voted
// (popup with a tab per answer); editing an answer (or its emoji) drops its votes; a one-answer
// poll; durations (24 hours by default, closing on time); ending early (closed at once, then a
// "poll ended" row with the result: a draw in a DM, a winner in a guild channel and a group DM);
// a multiple-choice poll in a guild channel.
//   node e2e/serve.mjs &   then   node e2e/polls.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Gives answer `n` (from 1) the first emoji the picker finds for `search`.
async function pickAnswerEmoji(page, n, search) {
  await page.click(`button[aria-label$="emoji to answer ${n}"], button[aria-label="Change the emoji of answer ${n}"]`);
  await page.fill('.poll-emoji-anchor input[placeholder="Find the perfect emoji"]', search);
  await page.click('.poll-emoji-anchor .emoji-picker-item >> nth=0');
  await page.waitForSelector('.poll-emoji-anchor', { state: 'detached' });
}

// Opens the + menu's poll dialog and posts a poll (`emoji`: { answer number: search }).
async function createPoll(page, question, answers, { multi = false, emoji = {}, duration } = {}) {
  await page.click('.attach-button');
  await page.click('.composer-add-item:has-text("Create poll")');
  await page.fill('#poll-question', question);
  for (let i = 0; i < answers.length; i++) {
    if (i >= 2) await page.click('text=+ Add another answer');
    await page.fill(`input[aria-label="Answer ${i + 1}"]`, answers[i]);
  }
  // A new poll starts with two rows; drop the unused one.
  if (answers.length === 1) await page.click('button[aria-label="Remove answer 2"]');
  if (multi) await page.check('text=Allow multiple answers');
  if (duration) await page.selectOption('#poll-duration', { label: duration });
  for (const [n, search] of Object.entries(emoji)) await pickAnswerEmoji(page, n, search);
  await shot(page, `dialog-${question.replace(/\W/g, '')}`);
  await page.click('.vc-dialog button:has-text("Post")');
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}

const pollOf = (page, question) => page.locator(`.poll:has(.poll-question:text-is("${question}"))`);
const option = (page, question, text) => pollOf(page, question).locator(`.poll-option:has-text("${text}")`);
// Taps (phone) or clicks.
const press = (page, locator) => (page.context()._options?.hasTouch ? locator.tap() : locator.click());

// Selects `texts` and presses Vote.
async function castVote(page, question, texts) {
  for (const text of texts) await press(page, option(page, question, text));
  await press(page, pollOf(page, question).locator('button:text-is("Vote")'));
  await pollOf(page, question).locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
}

// The count an answer shows in the results (opening them with Show results if needed).
async function waitForCount(page, question, text, n) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const show = pollOf(page, question).locator('button:text-is("Show results")');
    if (await show.count()) await press(page, show);
    const row = option(page, question, text);
    const label = (await row.count()) ? await row.getAttribute('aria-label') : null;
    if (label && Number(label.match(/: (\d+) vote/)?.[1]) === n) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`"${text}" never had ${n} votes (${question})`);
}

// The "poll ended" row for `question`.
const notice = (page, question) => page.locator(`.poll-end:has(strong:text-is("${question}"))`);

// Its author ends `question` now: closed at once, before the server has answered.
async function endPoll(page, question) {
  await pollOf(page, question).locator('button:text-is("End poll")').click();
  await page.click('.vc-dialog button.btn-danger:has-text("End poll")');
  await pollOf(page, question).locator('.poll-closed').waitFor({ timeout: 1500 });
  if (await pollOf(page, question).locator('.poll-footer:has-text("left")').count()) throw new Error('still counting down after End poll');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await openChat(a, bob.id);
  await openChat(b, alice.id);

  // The + button opens a menu.
  await a.click('.attach-button');
  await a.waitForSelector('.composer-add-menu :text("Upload a file")');
  await shot(a, '1-menu');
  await a.keyboard.press('Escape');

  // Tab: question → each answer → Add another answer (not the emoji or remove buttons).
  await a.click('.attach-button');
  await a.click('.composer-add-item:has-text("Create poll")');
  await a.click('text=+ Add another answer');
  await a.focus('#poll-question');
  const order = [];
  for (let i = 0; i < 4; i++) {
    await a.keyboard.press('Tab');
    order.push(await a.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim()));
  }
  if (order.join(' | ') !== 'Answer 1 | Answer 2 | Answer 3 | + Add another answer') throw new Error(`Tab order: ${order.join(' | ')}`);
  await a.keyboard.press('Escape');
  await a.waitForSelector('.vc-dialog', { state: 'detached' });
  console.log('poll dialog: Tab goes through the question, the answers, then Add another answer');

  await createPoll(a, 'Lunch?', ['Pizza', 'Soup'], { emoji: { 1: 'pizza' } });
  await b.waitForSelector('.poll-question:text-is("Lunch?")', { timeout: 10000 });
  await b.waitForSelector('.poll-option:has-text("Pizza") .poll-option-emoji img.emoji[alt="🍕"]');
  await b.waitForSelector('.poll-kind:text("Select one answer")');

  // Bob (phone) picks Pizza: nothing is sent until he presses Vote.
  if (!(await pollOf(b, 'Lunch?').locator('button:text-is("Vote")').isDisabled())) throw new Error('Vote enabled with nothing picked');
  await option(b, 'Lunch?', 'Pizza').tap();
  await option(b, 'Lunch?', 'Soup').tap(); // single choice: moves the pick
  if (await b.locator('.poll-option.selected').count() !== 1) throw new Error('single choice selected two');
  await shot(b, '2a-selecting-phone');
  await a.waitForTimeout(1000);
  await waitForCount(a, 'Lunch?', 'Soup', 0);
  await shot(a, '2b-results-before-voting');
  await press(b, pollOf(b, 'Lunch?').locator('button:text-is("Vote")'));
  await waitForCount(a, 'Lunch?', 'Soup', 1);
  // He changes his mind: Remove vote, then vote again. Still one vote.
  await option(b, 'Lunch?', 'Soup').waitFor();
  await b.tap('button:text-is("Remove vote")');
  await waitForCount(a, 'Lunch?', 'Soup', 0);
  await castVote(b, 'Lunch?', ['Pizza']);
  await waitForCount(a, 'Lunch?', 'Pizza', 1);
  // Alice, looking at the results, goes back and votes too.
  await a.click('button:text-is("Back to vote")');
  await castVote(a, 'Lunch?', ['Pizza']);
  await waitForCount(b, 'Lunch?', 'Pizza', 2);
  // Votes aren't reaction chips.
  if (await a.locator('.reaction-chip:not(.reaction-add)').count()) throw new Error('a vote showed as a reaction');
  await shot(a, '2-voted');
  await shot(b, '3-voted-phone');
  console.log('DM poll: select, Vote, Show results, Remove vote work');

  // Who voted: a popup with a tab per answer.
  await option(a, 'Lunch?', 'Pizza').click();
  await a.waitForSelector('.poll-voters-list li:has-text("(you)")');
  await a.waitForSelector(`.poll-voters-list li:has-text("${bob.name}")`);
  await a.click('.poll-voters-tab:has-text("Soup")');
  await a.waitForSelector('.poll-voters-list:has-text("Nobody has voted for this answer.")');
  await a.click('.poll-voters-tab:has-text("Pizza")');
  await shot(a, '3b-voters');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.poll-voters', { state: 'detached' });
  await option(b, 'Lunch?', 'Pizza').tap();
  await b.waitForSelector(`.poll-voters-list li:has-text("${alice.name}")`);
  // Holding a finger on it (long enough for a long press) doesn't open the message's actions.
  const box = await b.locator('.poll-voters-list li').first().boundingBox();
  const cdp = await b.context().newCDPSession(b);
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await b.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await b.waitForTimeout(200);
  if (await b.locator('.action-sheet').count()) throw new Error('a long press in the popup opened the message actions');
  await shot(b, '3c-voters-phone');
  await b.tap('.vc-dialog-close');
  console.log('who voted: popup with tabs works');

  // Alice edits the poll: renaming "Soup" drops its votes, the question and "Pizza" keep theirs.
  const row = a.locator('.each-dm-message-wrapper:has(.poll-question:text-is("Lunch?"))');
  await row.hover();
  await row.locator('button:has(svg[data-icon="pen-to-square"])').click();
  await a.waitForSelector('.vc-dialog:has-text("Edit poll")');
  if (!(await a.isDisabled('.vc-dialog input[type=checkbox]'))) throw new Error('multiple choice can be changed');
  await a.fill('#poll-question', 'Lunch today?');
  await a.fill('input[aria-label="Answer 2"]', 'Tomato soup');
  await a.waitForSelector('text=Changing an answer removes the votes it had.');
  await shot(a, '4-edit');
  await a.click('.vc-dialog button:has-text("Save")');
  await b.waitForSelector('.poll-question:text-is("Lunch today?")', { timeout: 10000 });
  await waitForCount(b, 'Lunch today?', 'Tomato soup', 0);
  await waitForCount(a, 'Lunch today?', 'Tomato soup', 0);
  await waitForCount(a, 'Lunch today?', 'Pizza', 2);
  // Bob votes again: his old vote (for the renamed answer) is cleared, not left behind.
  await b.tap('button:text-is("Remove vote")');
  await castVote(b, 'Lunch today?', ['Tomato soup']);
  await waitForCount(a, 'Lunch today?', 'Tomato soup', 1);
  await waitForCount(a, 'Lunch today?', 'Pizza', 1);
  console.log('DM poll: editing an answer drops its votes');

  // Changing only an answer's emoji is an edit too; Escape in the picker leaves the dialog open.
  const edited = a.locator('.each-dm-message-wrapper:has(.poll-question:text-is("Lunch today?"))');
  await edited.hover();
  await edited.locator('button:has(svg[data-icon="pen-to-square"])').click();
  await a.click('button[aria-label="Change the emoji of answer 1"]');
  await a.waitForSelector('.poll-emoji-anchor .emoji-picker');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.poll-emoji-anchor', { state: 'detached' });
  if (!(await a.isVisible('.vc-dialog:has-text("Edit poll")'))) throw new Error('Escape in the picker closed the dialog');
  await pickAnswerEmoji(a, 2, 'tomato');
  await a.waitForSelector('text=Changing an answer removes the votes it had.');
  await a.click('.vc-dialog button:has-text("Save")');
  await b.waitForSelector('.poll-option:has-text("Tomato soup") .poll-option-emoji img.emoji', { timeout: 10000 });
  await waitForCount(a, 'Lunch today?', 'Tomato soup', 0);
  await waitForCount(a, 'Lunch today?', 'Pizza', 1);
  // Removing Pizza's emoji is also an edit.
  await edited.hover();
  await edited.locator('button:has(svg[data-icon="pen-to-square"])').click();
  await a.click('button[aria-label="Remove the emoji of answer 1"]');
  await a.click('.vc-dialog button:has-text("Save")');
  await b.waitForFunction(() => !document.querySelector('.poll-option-emoji img[alt="🍕"]'), null, { timeout: 10000 });
  await waitForCount(b, 'Lunch today?', 'Pizza', 0);
  await shot(b, '4b-emoji-phone');
  console.log('DM poll: answer emoji show, and changing one drops its votes');

  // A poll with a single answer, and its reply preview.
  await createPoll(a, 'Anyone?', ['Me']);
  await pollOf(b, 'Anyone?').waitFor({ timeout: 10000 });
  await castVote(b, 'Anyone?', ['Me']);
  await waitForCount(a, 'Anyone?', 'Me', 1);
  console.log('one-answer poll works');

  // Durations: 24 hours unless picked. A 1-hour poll closes on its own (Bob's clock is moved on:
  // the vote he made in time still counts, and he can't vote or remove it any more).
  await a.click('.attach-button');
  await a.click('.composer-add-item:has-text("Create poll")');
  if (await a.$eval('#poll-duration option:checked', (o) => o.textContent) !== '24 hours') throw new Error('default duration is not 24 hours');
  await a.keyboard.press('Escape');
  await b.clock.install();
  await b.reload();
  await createPoll(a, 'Quick?', ['Yes', 'No'], { duration: '1 hour' });
  await pollOf(b, 'Quick?').waitFor({ timeout: 15000 });
  await pollOf(b, 'Quick?').locator('.poll-footer:has-text("59 minutes left")').waitFor();
  await castVote(b, 'Quick?', ['Yes']);
  await b.clock.fastForward('01:01:00');
  await pollOf(b, 'Quick?').locator('.poll-closed:text("Poll closed")').waitFor({ timeout: 5000 });
  await waitForCount(b, 'Quick?', 'Yes', 1);
  if (await pollOf(b, 'Quick?').locator('button:text-is("Remove vote"), button:text-is("Vote")').count()) throw new Error('a closed poll still takes votes');
  await shot(b, '4c-closed-phone');
  console.log('a poll closes when its time is up');

  // Ending one early: closed at once (no "less than a minute left" first), then a row with the
  // result for both (here a draw). Deleting the poll takes the row with it.
  await createPoll(a, 'Tea or coffee?', ['Tea', 'Coffee']);
  await pollOf(b, 'Tea or coffee?').waitFor({ timeout: 10000 });
  await castVote(b, 'Tea or coffee?', ['Coffee']);
  await pollOf(a, 'Tea or coffee?').locator('button:text-is("Back to vote"), button:text-is("Vote")').first().waitFor();
  if (await pollOf(a, 'Tea or coffee?').locator('button:text-is("Back to vote")').count()) await pollOf(a, 'Tea or coffee?').locator('button:text-is("Back to vote")').click();
  await castVote(a, 'Tea or coffee?', ['Tea']);
  await waitForCount(a, 'Tea or coffee?', 'Coffee', 1);
  await endPoll(a, 'Tea or coffee?');
  for (const page of [a, b]) {
    await notice(page, 'Tea or coffee?').waitFor({ timeout: 10000 });
    const text = await notice(page, 'Tea or coffee?').textContent();
    if (!text.includes("It's a draw between Tea and Coffee, 50% each.")) throw new Error(`draw row says: ${text}`);
  }
  await shot(a, '5b-draw');
  await shot(b, '5c-draw-phone');
  await notice(b, 'Tea or coffee?').locator('button:text-is("View poll")').tap();
  const teaRow = a.locator('.each-dm-message-wrapper:has(.poll-question:text-is("Tea or coffee?"))');
  await teaRow.hover();
  await teaRow.locator('.trash-button').click();
  await a.click('.vc-dialog button.btn-danger:has-text("Delete")');
  await notice(b, 'Tea or coffee?').waitFor({ state: 'detached', timeout: 10000 });
  console.log('ending a DM poll: closed at once, a draw announced to both, deleted with the poll');

  // A multiple-choice poll in a guild channel.
  const guild = await a.evaluate(async () => {
    const h = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const g = await (await fetch('/api/guilds', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Polls' }) })).json();
    const invite = await (await fetch(`/api/guilds/${g.id}/invites`, { method: 'POST', headers: h, body: '{}' })).json();
    return { id: g.id, channel: g.channels[0].id, code: invite.code };
  });
  await b.evaluate(async (code) => {
    await fetch(`/api/invites/${code}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  }, guild.code);
  await a.goto(`${BASE}/guild/${guild.id}/${guild.channel}`);
  await b.goto(`${BASE}/guild/${guild.id}/${guild.channel}`);
  await a.waitForSelector('#dm-input');
  await b.waitForSelector('#dm-input');
  await createPoll(a, 'Which days?', ['Mon', 'Tue', 'Wed'], { multi: true, emoji: { 3: 'tada' } });
  await b.waitForSelector('.poll-kind:text("Select one or more answers")', { timeout: 10000 });
  await option(b, 'Which days?', 'Mon').tap();
  await option(b, 'Which days?', 'Wed').tap();
  await shot(b, '5a-guild-selecting-phone');
  await press(b, pollOf(b, 'Which days?').locator('button:text-is("Vote")'));
  await waitForCount(a, 'Which days?', 'Wed', 1);
  await waitForCount(a, 'Which days?', 'Mon', 1);
  // Shares are of the votes cast (2), not of the people who voted (1).
  for (const day of ['Mon', 'Wed']) {
    const count = await option(a, 'Which days?', day).locator('.poll-count').textContent();
    if (count !== '1 · 50%') throw new Error(`${day} shows ${count}`);
  }
  await pollOf(a, 'Which days?').locator('.poll-footer:has-text("2 votes")').waitFor();
  await shot(a, '5-guild');
  await shot(b, '6-guild-phone');
  // Remove vote takes both back.
  await b.tap('button:text-is("Remove vote")');
  await waitForCount(a, 'Which days?', 'Mon', 0);
  await waitForCount(a, 'Which days?', 'Wed', 0);
  await castVote(b, 'Which days?', ['Tue']);
  await waitForCount(a, 'Which days?', 'Tue', 1);

  // Only the author can end it early; then it's closed for everyone and can't be edited.
  if (await pollOf(b, 'Which days?').locator('button:text-is("End poll")').count()) throw new Error('End poll offered to a voter');
  await pollOf(a, 'Which days?').locator('.poll-footer:has-text("23 hours left")').waitFor();
  await endPoll(a, 'Which days?');
  await pollOf(b, 'Which days?').locator('.poll-closed').waitFor({ timeout: 10000 });
  for (const page of [a, b]) {
    await notice(page, 'Which days?').waitFor({ timeout: 10000 });
    const text = await notice(page, 'Which days?').textContent();
    if (!text.includes('Tue won with 100% (1 of 1 vote).')) throw new Error(`guild row says: ${text}`);
  }
  await waitForCount(b, 'Which days?', 'Tue', 1);
  const guildRow = a.locator('.each-dm-message-wrapper:has(.poll-question:text-is("Which days?"))');
  await guildRow.hover();
  if (await guildRow.locator('button:has(svg[data-icon="pen-to-square"])').count()) throw new Error('a closed poll can be edited');
  await shot(a, '7-guild-ended');
  await shot(b, '8-guild-ended-phone');
  console.log('the author can end a poll early');
  console.log('guild multiple-choice poll works');

  // A group DM: the row reaches its members, the winner worked out on each device.
  const cal = await signUp(browser, 'cal');
  const c = cal.page;
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Pollsters');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  const groupUrl = a.url();
  await createPoll(a, 'Where to?', ['Beach', 'Hills', 'City'], { emoji: { 1: 'beach' } });
  for (const page of [b, c]) {
    await page.goto(groupUrl);
    await pollOf(page, 'Where to?').waitFor({ timeout: 20000 });
  }
  await castVote(b, 'Where to?', ['Beach']);
  await castVote(c, 'Where to?', ['Beach']);
  await waitForCount(a, 'Where to?', 'Beach', 2);
  await endPoll(a, 'Where to?');
  for (const page of [a, b, c]) {
    await notice(page, 'Where to?').waitFor({ timeout: 10000 });
    const text = await notice(page, 'Where to?').textContent();
    if (!text.includes('Beach won with 100% (2 of 2 votes).')) throw new Error(`group row says: ${text}`);
  }
  // Still there after a reload (it's a stored row, not worked out from the timer).
  await c.reload();
  await notice(c, 'Where to?').waitFor({ timeout: 20000 });
  await shot(c, '9-group-ended');
  await shot(b, '10-group-ended-phone');
  console.log('group DM poll: the result is announced to every member');
  console.log('polls: ok');
} catch (err) {
  console.error('polls: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
