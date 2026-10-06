// Open polls in a real browser: "Open poll" in the dialog (locked when editing); anyone adds an
// answer from the vote screen (not the results), neither voted for nor ticked; repeats refused (ignoring
// case); "added by" under other people's answers; the ✕ (asks first) for its creator, the poll's
// author or a guild moderator (not the author's answers), gone once someone else votes for it;
// back to the vote screen when that took your only vote; a new question drops every vote and
// added answer; nothing added or removed once closed. Encrypted DM (phone), guild channel (a
// moderator), group DM (signed answers, the author's removal).
//   node e2e/serve.mjs &   then   node e2e/openpolls.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Taps (phone) or clicks.
const press = (page, locator) => (page.context()._options?.hasTouch ? locator.tap() : locator.click());

// Posts an open poll from the + menu.
async function createOpenPoll(page, question, answers, { multi = false } = {}) {
  await page.click('.attach-button');
  await page.click('.composer-add-item:has-text("Create poll")');
  await page.fill('#poll-question', question);
  for (let i = 0; i < answers.length; i++) {
    if (i >= 2) await page.click('text=+ Add another answer');
    await page.fill(`input[aria-label="Answer ${i + 1}"]`, answers[i]);
  }
  if (answers.length === 1) await page.click('button[aria-label="Remove answer 2"]');
  if (multi) await page.check('.vc-dialog label:has-text("Allow multiple answers") input');
  await page.check('.vc-dialog label:has-text("Open poll") input');
  await page.click('.vc-dialog button:has-text("Post")');
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}

const pollOf = (page, question) => page.locator(`.poll:has(.poll-question:text-is("${question}"))`);
const row = (page, question, text) => pollOf(page, question).locator(`.poll-option-row:has(.poll-option-text:text-matches("^${text}"))`);
const removeX = (page, question, text) => row(page, question, text).locator('.poll-option-remove');
// An answer ticked on the vote screen.
const ticked = (page, question, text) => row(page, question, text).locator('.poll-option.selected');
// Presses Vote, and waits for the results.
async function castVote(page, question) {
  await press(page, pollOf(page, question).locator('button:text-is("Vote")'));
  await pollOf(page, question).locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
}
const resultsShown =(page, question) => pollOf(page, question).locator('.poll-option.result').first().isVisible();

// Types `text` in the poll's add box and presses Add.
async function addAnswer(page, question, text) {
  const box = pollOf(page, question).locator('.poll-add-answer input');
  await box.fill(text);
  await press(page, pollOf(page, question).locator('.poll-add-answer button:text-is("Add")'));
}

// The number of votes an answer shows, from its button's label (results).
async function votesOf(page, question, text) {
  const label = await row(page, question, text).locator('.poll-option').getAttribute('aria-label');
  return label ? Number(label.match(/: (\d+) vote/)?.[1]) : null;
}

async function waitFor(what, test, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

// Clicks an answer's ✕ and confirms.
async function removeAnswer(page, question, text) {
  await press(page, removeX(page, question, text));
  await page.waitForSelector(`.vc-dialog:has-text('Remove "${text}" from the poll?')`);
  await press(page, page.locator('.vc-dialog button.btn-danger:has-text("Remove")'));
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await openChat(a, bob.id);
  await openChat(b, alice.id);

  // ---- An encrypted DM ----
  await createOpenPoll(a, 'Dinner?', ['Pizza', 'Soup']);
  await pollOf(b, 'Dinner?').waitFor({ timeout: 10000 });
  await pollOf(b, 'Dinner?').locator('.poll-kind:has-text("Anyone can add answers")').waitFor();
  // A repeat (ignoring case) is refused, with nothing sent.
  await addAnswer(b, 'Dinner?', ' PIZZA ');
  await pollOf(b, 'Dinner?').locator('.poll-add-error:has-text("That answer is already in the poll.")').waitFor();
  await shot(b, '1-duplicate-phone');
  // Adding one neither votes for it nor ticks it (that would look like a vote): it's picked and
  // sent like any other.
  await addAnswer(b, 'Dinner?', 'Curry');
  await row(b, 'Dinner?', 'Curry').waitFor({ timeout: 10000 });
  await shot(b, '2b-added-phone');
  if (await pollOf(b, 'Dinner?').locator('.poll-option.selected').count()) throw new Error('adding an answer ticked it');
  await pollOf(a, 'Dinner?').locator('.poll-footer:has-text("0 votes")').waitFor();
  await press(b, row(b, 'Dinner?', 'Curry').locator('.poll-option'));
  await castVote(b, 'Dinner?');
  if (await votesOf(b, 'Dinner?', 'Curry') !== 1) throw new Error('Vote did not send the added answer');
  // No add box on the results.
  if (await pollOf(b, 'Dinner?').locator('.poll-add-answer').count()) throw new Error('add box on the results');
  // Alice sees it, with who added it, and (only Bob voted, its creator) a ✕.
  await row(a, 'Dinner?', 'Curry').waitFor({ timeout: 10000 });
  await row(a, 'Dinner?', 'Curry').locator(`.poll-option-by:text-is("added by ${bob.name}")`).waitFor();
  if (await row(a, 'Dinner?', 'Pizza').locator('.poll-option-by').count()) throw new Error("the author's answer says who added it");
  await shot(a, '2-added-by');
  await shot(b, '3-added-phone');
  if (await a.locator('.reaction-chip:not(.reaction-add)').count()) throw new Error('an added answer showed as a reaction');
  console.log('DM: repeats refused; an added answer is neither ticked nor voted; "added by" shown');

  // The author removes it (asks first): gone for both, and Bob, whose only vote it was, is back
  // on the vote screen.
  await press(a, removeX(a, 'Dinner?', 'Curry'));
  await a.waitForSelector('.vc-dialog:has-text(\'Remove "Curry" from the poll?\')');
  await a.click('.vc-dialog button:has-text("Cancel")');
  if (!(await row(a, 'Dinner?', 'Curry').count())) throw new Error('Cancel removed it');
  await removeAnswer(a, 'Dinner?', 'Curry');
  await row(b, 'Dinner?', 'Curry').waitFor({ state: 'detached', timeout: 10000 });
  await pollOf(b, 'Dinner?').locator('button:text-is("Vote")').waitFor();
  await pollOf(b, 'Dinner?').locator('.poll-add-answer').waitFor();
  console.log('DM: the author removes an answer (after asking); its creator is back to voting');

  // Bob removes his own. The ✕ is only on the vote screen: on the results (he's voted for it)
  // there's none until he takes his vote back.
  await addAnswer(b, 'Dinner?', 'Tacos');
  await removeX(b, 'Dinner?', 'Tacos').waitFor({ timeout: 10000 });
  await press(b, row(b, 'Dinner?', 'Tacos').locator('.poll-option'));
  await castVote(b, 'Dinner?');
  await shot(b, '3b-results-no-x-phone');
  if (await pollOf(b, 'Dinner?').locator('.poll-option-remove').count()) throw new Error('a ✕ on the results');
  await press(b, pollOf(b, 'Dinner?').locator('button:text-is("Remove vote")'));
  await removeX(b, 'Dinner?', 'Tacos').waitFor({ timeout: 10000 });
  await removeAnswer(b, 'Dinner?', 'Tacos');
  await row(a, 'Dinner?', 'Tacos').waitFor({ state: 'detached', timeout: 10000 });
  await pollOf(b, 'Dinner?').locator('button:text-is("Vote")').waitFor();
  console.log('DM: its creator removes their own, from the vote screen only');

  // Someone else's vote keeps it: Alice votes for Bob's Ramen, so Bob loses his ✕.
  await addAnswer(b, 'Dinner?', 'Ramen');
  await row(a, 'Dinner?', 'Ramen').waitFor({ timeout: 10000 });
  await waitFor('Bob has a ✕ on his answer', async () => (await removeX(b, 'Dinner?', 'Ramen').count()) === 1);
  await press(a, row(a, 'Dinner?', 'Ramen').locator('.poll-option'));
  await press(a, pollOf(a, 'Dinner?').locator('button:text-is("Vote")'));
  await waitFor('Ramen has a vote', async () => (await votesOf(a, 'Dinner?', 'Ramen')) === 1);
  await waitFor("Bob's ✕ goes", async () => (await removeX(b, 'Dinner?', 'Ramen').count()) === 0);
  if (await pollOf(a, 'Dinner?').locator('.poll-option-remove').count()) throw new Error('a ✕ on the results');
  await shot(b, '4-voted-by-others-phone');
  console.log("DM: someone else's vote takes the ✕ away from its creator");

  // A new question drops every vote and added answer (the dialog says so); open stays locked.
  const pollRow = a.locator('.each-dm-message-wrapper:has(.poll-question:text-is("Dinner?"))');
  await pollRow.hover();
  await pollRow.locator('button:has(svg[data-icon="pen-to-square"])').click();
  await a.waitForSelector('.vc-dialog:has-text("Edit poll")');
  if (!(await a.locator('.vc-dialog label:has-text("Open poll") input').isDisabled())) throw new Error('Open poll can be changed');
  if (!(await a.locator('.vc-dialog label:has-text("Open poll") input').isChecked())) throw new Error('Open poll not shown as on');
  await a.fill('#poll-question', 'Dinner tonight?');
  await a.waitForSelector('text=Changing the question removes every vote and the answers people added.');
  await shot(a, '5-edit-question');
  await a.click('.vc-dialog button:has-text("Save")');
  await pollOf(b, 'Dinner tonight?').waitFor({ timeout: 10000 });
  await row(b, 'Dinner tonight?', 'Ramen').waitFor({ state: 'detached', timeout: 10000 });
  await pollOf(b, 'Dinner tonight?').locator('button:text-is("Vote")').waitFor();
  await pollOf(a, 'Dinner tonight?').locator('.poll-footer:has-text("0 votes")').waitFor();
  console.log('DM: a new question drops every vote and added answer');

  // ---- A guild channel: a moderator, and the author's own answers ----
  const cal = await signUp(browser, 'cal');
  const c = cal.page;
  const guild = await a.evaluate(async (MANAGE_MESSAGES) => {
    const h = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const g = await (await fetch('/api/guilds', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Open polls' }) })).json();
    const invite = await (await fetch(`/api/guilds/${g.id}/invites`, { method: 'POST', headers: h, body: '{}' })).json();
    const role = await (await fetch(`/api/guilds/${g.id}/roles`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Mods', permissions: MANAGE_MESSAGES }) })).json();
    return { id: g.id, channel: g.channels[0].id, code: invite.code, role: role.id };
  }, 1 << 3);
  for (const page of [b, c]) {
    await page.evaluate(async (code) => {
      await fetch(`/api/invites/${code}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    }, guild.code);
  }
  await a.evaluate(async ({ guildId, userId, role }) => {
    const h = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    await fetch(`/api/guilds/${guildId}/members/${userId}/roles`, { method: 'PUT', headers: h, body: JSON.stringify({ roleIds: [role] }) });
  }, { guildId: guild.id, userId: cal.id, role: guild.role });
  for (const page of [a, b, c]) {
    await page.goto(`${BASE}/guild/${guild.id}/${guild.channel}`);
    await page.waitForSelector('#dm-input');
  }
  await createOpenPoll(a, 'Games?', ['Chess', 'Go'], { multi: true });
  await pollOf(b, 'Games?').waitFor({ timeout: 10000 });
  // Bob ticks Chess, adds Shogi (Chess stays ticked, Shogi isn't), ticks it too and votes for both.
  await press(b, row(b, 'Games?', 'Chess').locator('.poll-option'));
  await addAnswer(b, 'Games?', 'Shogi');
  await row(b, 'Games?', 'Shogi').waitFor({ timeout: 10000 });
  if (await ticked(b, 'Games?', 'Shogi').count()) throw new Error('adding an answer ticked it');
  if (!(await ticked(b, 'Games?', 'Chess').count())) throw new Error('adding an answer unticked another');
  await press(b, row(b, 'Games?', 'Shogi').locator('.poll-option'));
  await castVote(b, 'Games?');
  await waitFor('Chess and Shogi have a vote each', async () =>
    (await votesOf(b, 'Games?', 'Chess')) === 1 && (await votesOf(b, 'Games?', 'Shogi')) === 1);
  // Alice adds one too: no "added by" (she's the author), and the moderator can't remove it.
  await pollOf(a, 'Games?').waitFor();
  await addAnswer(a, 'Games?', 'Backgammon');
  await row(c, 'Games?', 'Backgammon').waitFor({ timeout: 10000 });
  if (await row(c, 'Games?', 'Backgammon').locator('.poll-option-by').count()) throw new Error("the author's added answer says who added it");
  if (await removeX(c, 'Games?', 'Backgammon').count()) throw new Error("a moderator can remove the author's answer");
  if (await removeX(c, 'Games?', 'Chess').count()) throw new Error("a moderator can remove the poll's own answer");
  await shot(c, '6-guild-moderator');
  // Cal (Manage Messages) removes Bob's: gone for everyone, with Bob's vote for it.
  await removeAnswer(c, 'Games?', 'Shogi');
  await row(b, 'Games?', 'Shogi').waitFor({ state: 'detached', timeout: 10000 });
  await waitFor("Bob's other vote stays", async () => (await votesOf(b, 'Games?', 'Chess')) === 1);
  // He still has a vote (Chess), so he stays on the results.
  if (!(await resultsShown(b, 'Games?'))) throw new Error('Bob left the results with a vote still cast');
  await shot(b, '7-guild-removed-phone');
  console.log("guild: a moderator removes an answer (with its votes), not the author's; Bob keeps his other vote");

  // Closed: nothing can be added or removed.
  await pollOf(a, 'Games?').locator('button:text-is("End poll")').click();
  await a.click('.vc-dialog button.btn-danger:has-text("End poll")');
  await pollOf(c, 'Games?').locator('.poll-closed').waitFor({ timeout: 10000 });
  for (const page of [a, b, c]) {
    if (await pollOf(page, 'Games?').locator('.poll-add-answer, .poll-option-remove').count()) throw new Error('a closed poll can still change');
  }
  console.log('guild: a closed poll takes no answers and loses none');

  // ---- A group DM: signed answers, and the author's removal ----
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Open pollsters');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  const groupUrl = a.url();
  await createOpenPoll(a, 'Where to?', ['Beach']);
  for (const page of [b, c]) {
    await page.goto(groupUrl);
    await pollOf(page, 'Where to?').waitFor({ timeout: 20000 });
  }
  await addAnswer(b, 'Where to?', 'Hills');
  await row(c, 'Where to?', 'Hills').locator(`.poll-option-by:text-is("added by ${bob.name}")`).waitFor({ timeout: 10000 });
  // Cal (a moderator in the guild, not here) has no ✕; the author has.
  if (await removeX(c, 'Where to?', 'Hills').count()) throw new Error('someone else can remove it in a group');
  await removeAnswer(a, 'Where to?', 'Hills');
  await row(c, 'Where to?', 'Hills').waitFor({ state: 'detached', timeout: 10000 });
  // Still gone after a reload (the removal is stored, signed by the author).
  await c.reload();
  await pollOf(c, 'Where to?').waitFor({ timeout: 20000 });
  await c.waitForTimeout(1000);
  if (await row(c, 'Where to?', 'Hills').count()) throw new Error('the removed answer came back after a reload');
  await shot(c, '8-group');
  console.log('group DM: added answers reach everyone; the author removes one');
  console.log('open polls: ok');
} catch (err) {
  console.error('open polls: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
