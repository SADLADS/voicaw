// List channels (tasks) in a real browser: Alice makes a list channel, adds tasks and a
// subtask, drags tasks to reorder and nest them, opens one to assign Bob, set a due date,
// write a description and comment; Bob sees it all live (and "Assigned to me"). Then @everyone
// loses Edit Tasks: Bob can still read and comment but not change anything. Then a phone.
//   node e2e/serve.mjs &   then   node e2e/lists.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// The board's task titles, top to bottom, with their depth: "A, ·B, C".
const tree = (page) => page.$$eval('[data-task-row]', (rows) => rows.map((r) => {
  const depth = Number(getComputedStyle(r).getPropertyValue('--task-depth') || 0);
  return `${'·'.repeat(depth)}${r.querySelector('.task-title').textContent}`;
}).join(', '));

async function waitForTree(page, expected) {
  try {
    await page.waitForFunction((want) => [...document.querySelectorAll('[data-task-row]')].map((r) => {
      const depth = Number(getComputedStyle(r).getPropertyValue('--task-depth') || 0);
      return `${'·'.repeat(depth)}${r.querySelector('.task-title').textContent}`;
    }).join(', ') === want, expected, { timeout: 5000 });
  } catch {
    throw new Error(`expected tree "${expected}", got "${await tree(page)}"`);
  }
}

// Drags a task's row (by title) onto another's, at `where` of its height (0.5: the middle,
// making it a subtask; 0.1: just above).
async function drag(page, title, ontoTitle, where) {
  const from = await page.locator(`[data-task-row]:has(> .task-row-main > .task-title:text-is("${title}"))`).boundingBox();
  const to = await page.locator(`[data-task-row]:has(> .task-row-main > .task-title:text-is("${ontoTitle}"))`).boundingBox();
  await page.mouse.move(from.x + 200, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x + 200, to.y + to.height * where, { steps: 8 });
  await page.mouse.up();
}

async function addTask(page, title) {
  await page.fill('input[aria-label="New task title"]', title);
  await page.press('input[aria-label="New task title"]', 'Enter');
  await page.waitForSelector(`.task-title:text-is("${title}")`);
}

const browser = await launchChrome();
const pages = [];
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  pages.push(['alice', a], ['bob', b]);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Project X');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');

  // A list channel.
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.check('input[name="channel-type"][value="list"]');
  await a.fill('#channel-name', 'Roadmap');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.click('.guild-channel-link:has-text("roadmap")');
  await a.waitForSelector('input[aria-label="New task title"]');
  await b.click('.guild-channel-link:has-text("roadmap")');
  await b.waitForSelector('.task-board');
  console.log('list channel made; both on it');

  for (const title of ['Design', 'Build', 'Ship']) await addTask(a, title);
  await waitForTree(b, 'Design, Build, Ship');
  console.log('tasks added, live for bob:', await tree(b));

  // A subtask from the row's + button.
  await a.hover('[data-task-row]:has(.task-title:text-is("Design"))');
  await a.click('button[aria-label="Add a subtask to Design"]');
  await a.fill('input[aria-label="New subtask of Design"]', 'Sketches');
  await a.press('input[aria-label="New subtask of Design"]', 'Enter');
  await waitForTree(a, 'Design, ·Sketches, Build, Ship');
  await a.press('input[aria-label="New subtask of Design"]', 'Escape');

  // Drag Ship onto the middle of Build (subtask), then Build above Design.
  await drag(a, 'Ship', 'Build', 0.5);
  await waitForTree(a, 'Design, ·Sketches, Build, ·Ship');
  await drag(a, 'Build', 'Design', 0.1);
  await waitForTree(a, 'Build, ·Ship, Design, ·Sketches');
  await waitForTree(b, 'Build, ·Ship, Design, ·Sketches');
  console.log('dragged (nest + reorder), live for bob:', await tree(b));
  await a.reload();
  await waitForTree(a, 'Build, ·Ship, Design, ·Sketches');
  console.log('order kept after reload');

  // Open Design: assign Bob, due date, description, comment.
  await a.click('[data-task-row] .task-title:text-is("Design")');
  await a.waitForSelector('aside.task-detail');
  await a.click('.task-assign-buttons button[aria-expanded]');
  await a.click(`.task-assignee-option:has-text("${bob.name}")`);
  await a.waitForSelector(`.task-assignee-chip:has-text("${bob.name}")`);
  await a.keyboard.press('Escape');
  await a.fill('input[aria-label="Due date"]', '2020-01-15');
  await a.waitForSelector('[data-task-row] .task-due.overdue');
  await a.click('.task-section-title button:has-text("Add")');
  await a.fill('textarea[aria-label="Description"]', 'Mock-ups **first**, then the style guide.');
  await a.click('.task-description-edit button:has-text("Save")');
  await a.waitForSelector('.task-description strong:text("first")');
  await a.fill('textarea[aria-label="Write a comment"]', 'Bob, can you take this?');
  await a.press('textarea[aria-label="Write a comment"]', 'Enter');
  await a.waitForSelector('.task-comment:has-text("Bob, can you take this?")');
  await shot(a, 'task-detail');
  // With the details open the board is narrow: every title must still show.
  const narrowest = await a.$$eval('[data-task-row] .task-title', (els) => Math.min(...els.map((e) => e.getBoundingClientRect().width)));
  if (narrowest < 40) throw new Error(`a task title is ${narrowest}px wide beside the details`);
  await a.waitForSelector('.task-detail .task-due-status.overdue');
  console.log('assigned, due date (overdue), description, comment');

  // Bob: the assignment and comment count live; "Assigned to me"; opening it shows the comment.
  await b.waitForSelector('[data-task-row]:has(.task-title:text-is("Design")) .task-assignee-avatar');
  await b.waitForSelector('[data-task-row]:has(.task-title:text-is("Design")) .task-comment-count');
  await b.click('.task-filter:has-text("Assigned to me")');
  await waitForTree(b, 'Design');
  await b.click('.task-filter:has-text("All")');
  await b.click('[data-task-row] .task-title:text-is("Design")');
  await b.waitForSelector('.task-comment:has-text("Bob, can you take this?")');
  await b.fill('textarea[aria-label="Write a comment"]', 'On it 👍');
  await b.press('textarea[aria-label="Write a comment"]', 'Enter');
  await a.waitForSelector('.task-comment:has-text("On it")');
  console.log('bob sees the assignment, filters to it, comments back live');

  // Completing Sketches (bob) shows on alice's board and in the progress count.
  await b.click('button[aria-label="Mark \\"Sketches\\" done"]');
  await a.waitForSelector('[data-task-row].done .task-title:text-is("Sketches")');
  await a.waitForSelector('[data-task-row]:has(.task-title:text-is("Design")) .task-progress.complete');
  await shot(b, 'board-bob');
  console.log('completed live, subtask progress 1/1');

  // Read-only for @everyone: Alice denies Edit Tasks in the channel's Permissions tab.
  await a.hover('.guild-channel:has-text("roadmap")');
  await a.click('button[aria-label="Edit roadmap"]');
  await a.click('.settings-tab:has-text("Permissions")');
  await a.waitForSelector('.override-grid');
  await a.click('button[aria-label="Deny Edit Tasks"]');
  await a.waitForSelector('button[aria-label="Deny Edit Tasks"][aria-checked="true"]');
  await shot(a, 'list-permissions');
  await a.click('button:has-text("Done")');
  await b.waitForSelector('input[aria-label="New task title"]', { state: 'detached' });
  if (!(await b.isDisabled('button[aria-label="Mark \\"Build\\" done"]'))) throw new Error('bob can still complete tasks');
  if (await b.$('button[aria-label="Delete task"]')) throw new Error('bob can still delete');
  await b.fill('textarea[aria-label="Write a comment"]', 'Still allowed to comment');
  await b.press('textarea[aria-label="Write a comment"]', 'Enter');
  await a.waitForSelector('.task-comment:has-text("Still allowed to comment")');
  console.log('read-only for bob (no add, complete or delete), comments still work');

  // A phone: the board fills the screen; a task's details cover it; deep link works.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(`${BASE}/`);
  await p.evaluate((token) => localStorage.setItem('token', token), await a.evaluate(() => localStorage.getItem('token')));
  const url = new URL(a.url());
  await p.goto(`${BASE}${url.pathname}`);
  await p.waitForSelector('.task-board');
  await shot(p, 'phone-board');
  await p.click('[data-task-row] .task-title:text-is("Design")');
  await p.waitForSelector('aside.task-detail');
  const box = await p.locator('aside.task-detail').boundingBox();
  const viewport = p.viewportSize();
  if (Math.round(box.width) !== viewport.width) throw new Error(`detail ${box.width}px wide on a ${viewport.width}px phone`);
  await shot(p, 'phone-detail');
  await p.click('button[aria-label="Close task"]');
  await p.waitForSelector('aside.task-detail', { state: 'detached' });
  console.log('phone: full-screen details, closes');

  // Deleting a task with subtasks asks first and removes them for everyone.
  await a.click('[data-task-row] .task-title:text-is("Build")');
  await a.click('button[aria-label="Delete task"]');
  await a.click('.vc-dialog button:has-text("Delete")');
  await waitForTree(b, 'Design, ·Sketches');
  console.log('deleted with its subtask, live for bob');

  console.log('lists e2e: ok');
} catch (err) {
  console.error('lists e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  for (const [name, page] of pages) await shot(page, `failed-${name}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
