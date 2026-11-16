// Long poll answers (110 characters, twice the old 55) in a real browser: the dialog's boxes
// stop at 110 and grow onto more lines (one line: no line breaks), a poll of long answers wraps neatly on a computer and a phone (vote screen and
// results, an emoji beside one), an answer of 110 added to an open poll goes through as an
// encrypted reaction padded to 512 bytes (DM) and a signed one (group DM), and reaches the
// others; light theme too.
//   node e2e/serve.mjs &   then   node e2e/longpolls.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE, makeFriends } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const press = (page, locator) => (page.context()._options?.hasTouch ? locator.tap() : locator.click());

const LONG = [
  'Saturday afternoon at the park by the river, weather permitting, with a picnic and the frisbee we never use',
  'Sunday brunch at that café on the high street that does the really good pancakes and opens at ten',
  'Pizza',
];
const ADDED = 'Next weekend instead, since half of us are away this time and it would be a real shame to go without everyone!';
if (LONG.some((a) => a.length > 110) || ADDED.length !== 110) throw new Error(`fixture lengths: ${LONG.map((a) => a.length)} ${ADDED.length}`);

const pollOf = (page, question) => page.locator(`.poll:has(.poll-question:text-is("${question}"))`);
const optionText = (page, question, start) => pollOf(page, question).locator(`.poll-option-text:text-matches("^${start}")`);

async function createPoll(page, question, answers, { open = false } = {}) {
  await page.click('.attach-button');
  await page.click('.composer-add-item:has-text("Create poll")');
  await page.fill('#poll-question', question);
  for (let i = 0; i < answers.length; i++) {
    if (i >= 2) await page.click('text=+ Add another answer');
    await page.fill(`textarea[aria-label="Answer ${i + 1}"]`, answers[i]);
  }
  if (open) await page.check('.vc-dialog label:has-text("Open poll") input');
  await page.click('.vc-dialog button:has-text("Post")');
  await page.waitForSelector('.vc-dialog', { state: 'detached' });
}

// No answer's text runs out of its button, and the buttons stay inside the poll card.
async function checkLayout(page, question, what) {
  const problems = await pollOf(page, question).evaluate((poll) => {
    const out = [];
    const card = poll.getBoundingClientRect();
    if (poll.scrollWidth > poll.clientWidth + 1) out.push('poll scrolls sideways');
    for (const button of poll.querySelectorAll('.poll-option')) {
      const box = button.getBoundingClientRect();
      if (box.right > card.right + 1 || box.left < card.left - 1) out.push(`button outside the card: ${button.textContent.slice(0, 20)}`);
      const text = button.querySelector('.poll-option-text');
      if (text && text.scrollWidth > text.clientWidth + 1) out.push(`text overflows: ${text.textContent.slice(0, 20)}`);
      const count = button.querySelector('.poll-count');
      if (count && count.getBoundingClientRect().right > box.right + 1) out.push('count cut off');
    }
    return out;
  });
  if (problems.length) throw new Error(`${what}: ${problems.join('; ')}`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await openChat(a, bob.id);
  await openChat(b, alice.id);

  // ---- The dialog stops at 110 characters ----
  await a.click('.attach-button');
  await a.click('.composer-add-item:has-text("Create poll")');
  await a.click('textarea[aria-label="Answer 1"]');
  await a.keyboard.insertText('y'.repeat(130));
  const typed = await a.inputValue('textarea[aria-label="Answer 1"]');
  if (typed.length !== 110) throw new Error(`answer box took ${typed.length} characters`);
  // One line: a pasted line break becomes a space.
  await a.fill('textarea[aria-label="Answer 1"]', 'two\nlines');
  if (await a.inputValue('textarea[aria-label="Answer 1"]') !== 'two lines') throw new Error('an answer kept a line break');
  await a.fill('textarea[aria-label="Answer 1"]', LONG[0]);
  // The box grows to show all of it instead of scrolling sideways.
  const fits = await a.$eval('textarea[aria-label="Answer 1"]', (el) => el.scrollHeight <= el.clientHeight + 1 && el.clientHeight > 50);
  if (!fits) throw new Error("a long answer's box didn't grow");
  await shot(a, '1-dialog');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.vc-dialog', { state: 'detached' });
  console.log('dialog: an answer box takes 110 characters, no more');

  // ---- A poll of long answers, open, in an encrypted DM ----
  await createPoll(a, 'When shall we meet?', LONG, { open: true });
  await pollOf(b, 'When shall we meet?').waitFor({ timeout: 20000 });
  await checkLayout(a, 'When shall we meet?', 'computer, vote screen');
  await checkLayout(b, 'When shall we meet?', 'phone, vote screen');
  await shot(a, '2-vote');
  await pollOf(b, 'When shall we meet?').scrollIntoViewIfNeeded();
  await shot(b, '3-vote-phone');

  // Bob (phone) adds a 110-character answer: an encrypted reaction, padded to 512 bytes.
  const sizes = [];
  b.on('request', (r) => {
    if (r.url().endsWith('/api/dm-reactions') && r.method() === 'POST') sizes.push(JSON.parse(r.postData()).content.length);
  });
  const box = pollOf(b, 'When shall we meet?').locator('.poll-add-answer input');
  await box.tap();
  await b.keyboard.insertText(ADDED + 'zzz');
  if ((await box.inputValue()).length !== 110) throw new Error('add box took more than 110');
  await press(b, pollOf(b, 'When shall we meet?').locator('.poll-add-answer button:text-is("Add")'));
  await optionText(a, 'When shall we meet?', 'Next weekend').waitFor({ timeout: 15000 });
  if (!sizes.length || sizes.some((n) => n !== 723)) throw new Error(`reaction sizes sent: ${sizes}`);
  const shown = await optionText(a, 'When shall we meet?', 'Next weekend').evaluate((el) => el.firstChild.textContent);
  if (shown !== ADDED) throw new Error(`added answer shown as: ${shown}`);
  await checkLayout(a, 'When shall we meet?', 'computer, with the added answer');
  console.log('DM: a 110-character answer added from a phone (723-character encrypted reaction) reaches the other side whole');

  // Both vote; results wrap with the counts beside them.
  await press(a, optionText(a, 'When shall we meet?', 'Saturday'));
  await press(a, pollOf(a, 'When shall we meet?').locator('button:text-is("Vote")'));
  await pollOf(a, 'When shall we meet?').locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
  await press(b, optionText(b, 'When shall we meet?', 'Next weekend'));
  await press(b, pollOf(b, 'When shall we meet?').locator('button:text-is("Vote")'));
  await pollOf(b, 'When shall we meet?').locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
  await checkLayout(a, 'When shall we meet?', 'computer, results');
  await checkLayout(b, 'When shall we meet?', 'phone, results');
  await shot(a, '4-results');
  await pollOf(b, 'When shall we meet?').scrollIntoViewIfNeeded();
  await shot(b, '5-results-phone');

  // Light theme.
  await a.evaluate(() => localStorage.setItem('theme', 'light'));
  await a.reload();
  await pollOf(a, 'When shall we meet?').waitFor({ timeout: 20000 });
  await checkLayout(a, 'When shall we meet?', 'computer, light');
  await shot(a, '6-results-light');
  await a.evaluate(() => localStorage.setItem('theme', 'dark'));
  console.log('long answers wrap inside the card: vote screen, results, phone, light');

  // ---- A group DM: the signed reaction for a 110-character answer ----
  const cal = await signUp(browser, 'cal');
  await makeFriends(alice, bob, cal);
  const c = cal.page;
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Long pollsters');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  const groupUrl = a.url();
  await createPoll(a, 'Where to?', ['Beach', LONG[1]], { open: true });
  for (const page of [b, c]) {
    await page.goto(groupUrl);
    await pollOf(page, 'Where to?').waitFor({ timeout: 20000 });
  }
  await c.fill('.poll-add-answer input', ADDED);
  await c.click('.poll-add-answer button:text-is("Add")');
  for (const page of [a, b]) await optionText(page, 'Where to?', 'Next weekend').waitFor({ timeout: 15000 });
  await checkLayout(b, 'Where to?', 'phone, group');
  await pollOf(b, 'Where to?').scrollIntoViewIfNeeded();
  await shot(b, '7-group-phone');
  console.log('group DM: a 110-character added answer (signed reaction) reaches every member');
  console.log('long polls: all good');
} finally {
  await browser.close();
}
