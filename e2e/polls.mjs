// Polls in a real browser: made from the + menu, voted on live (encrypted DM, phone), changing
// a single-choice vote, editing an answer drops its votes, a multiple-choice poll in a guild
// channel, and a one-answer poll.
//   node e2e/serve.mjs &   then   node e2e/polls.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Opens the + menu's poll dialog and posts a poll.
async function createPoll(page, question, answers, { multi = false } = {}) {
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
  await page.click('.vc-dialog button:has-text("Post")');
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}

const option = (page, question, text) => page.locator(`.poll:has(.poll-question:text-is("${question}")) .poll-option:has-text("${text}")`);
const countOf = async (page, question, text) => (await option(page, question, text).getAttribute('aria-label')).match(/: (\d+) vote/)[1];
async function waitForCount(page, question, text, n) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await option(page, question, text).count() && Number(await countOf(page, question, text)) === n) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`"${text}" never had ${n} votes (${question})`);
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

  await createPoll(a, 'Lunch?', ['Pizza', 'Soup']);
  await b.waitForSelector('.poll-question:text-is("Lunch?")', { timeout: 10000 });
  await b.waitForSelector('.poll-kind:text("Select one answer")');

  // Bob (phone) votes; Alice sees it live. Then he changes his mind: still one vote.
  await option(b, 'Lunch?', 'Pizza').tap();
  await waitForCount(a, 'Lunch?', 'Pizza', 1);
  await option(b, 'Lunch?', 'Soup').tap();
  await waitForCount(a, 'Lunch?', 'Soup', 1);
  await waitForCount(a, 'Lunch?', 'Pizza', 0);
  await option(a, 'Lunch?', 'Soup').click();
  await waitForCount(b, 'Lunch?', 'Soup', 2);
  // Votes aren't reaction chips.
  if (await a.locator('.reaction-chip:not(.reaction-add)').count()) throw new Error('a vote showed as a reaction');
  await shot(a, '2-voted');
  await shot(b, '3-voted-phone');
  console.log('DM poll: voting and changing a vote work');

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
  if (await b.locator('.poll-footer:text("0 votes")').count() !== 1) throw new Error('old votes still counted');
  // Bob votes again: his old vote (for the renamed answer) is cleared, not left behind.
  await option(b, 'Lunch today?', 'Tomato soup').tap();
  await waitForCount(a, 'Lunch today?', 'Tomato soup', 1);
  console.log('DM poll: editing an answer drops its votes');

  // A poll with a single answer, and its reply preview.
  await createPoll(a, 'Anyone?', ['Me']);
  await waitForCount(b, 'Anyone?', 'Me', 0);
  await option(b, 'Anyone?', 'Me').tap();
  await waitForCount(a, 'Anyone?', 'Me', 1);
  console.log('one-answer poll works');

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
  await createPoll(a, 'Which days?', ['Mon', 'Tue', 'Wed'], { multi: true });
  await b.waitForSelector('.poll-kind:text("Select one or more answers")', { timeout: 10000 });
  await option(b, 'Which days?', 'Mon').tap();
  await waitForCount(a, 'Which days?', 'Mon', 1);
  await option(b, 'Which days?', 'Wed').tap();
  await waitForCount(a, 'Which days?', 'Wed', 1);
  await waitForCount(a, 'Which days?', 'Mon', 1);
  // Tapping again takes the vote back.
  await option(b, 'Which days?', 'Mon').tap();
  await waitForCount(a, 'Which days?', 'Mon', 0);
  await shot(a, '5-guild');
  await shot(b, '6-guild-phone');
  console.log('guild multiple-choice poll works');
  console.log('polls: ok');
} catch (err) {
  console.error('polls: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
