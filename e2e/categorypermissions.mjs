// Category permissions (docs/guilds.md): Alice makes a private category, Bob (a member) never
// sees it or its channels; a channel dragged in from another category takes its permissions
// (Synced in its Permissions tab), a hand change makes it "Not synced", Sync now puts it back;
// the category's own Permissions tab, and the dialogs in the dark, light and Slack themes.
//   node e2e/serve.mjs &   then   node e2e/categorypermissions.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ✓ ${what}`);
};
const names = (page, selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Sorted');
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

  // A private category, made from the header menu.
  await a.click('.guild-header-button');
  await a.click('text=Create Category');
  await a.fill('#category-name', 'Staff');
  await a.check('.private-toggle input');
  await shot(a, '01-create-private-category');
  await a.click('button[type=submit]:has-text("Create category")');
  await a.waitForSelector('.guild-category-toggle:has-text("Staff")');

  // A channel in it starts private; Bob sees neither.
  await a.hover('.guild-category-toggle:has-text("Staff")');
  await a.click('button[aria-label="Create channel in Staff"]');
  await a.fill('#channel-name', 'plans');
  await a.click('button[type=submit]:has-text("Create channel")');
  await a.waitForSelector('.guild-channel-name:text-is("plans")');
  await b.waitForTimeout(800);
  check(!(await names(b, '.guild-category-toggle span')).includes('Staff'), 'Bob doesn\'t see the private category');
  check(!(await names(b, '.guild-channel-name')).includes('plans'), 'nor its channel');

  // A second channel in Text Channels, dragged into Staff: it takes Staff's permissions.
  await a.hover('.guild-category-toggle:has-text("Text Channels")');
  await a.click('button[aria-label="Create channel in Text Channels"]');
  await a.fill('#channel-name', 'notes');
  await a.click('button[type=submit]:has-text("Create channel")');
  await a.waitForSelector('.guild-channel-name:text-is("notes")');
  check((await names(b, '.guild-channel-name')).includes('notes'), 'Bob sees #notes while it is in Text Channels');
  const from = await a.locator('.guild-channel-link', { hasText: 'notes' }).boundingBox();
  const to = await a.locator('.guild-channel-link', { hasText: 'plans' }).boundingBox();
  await a.mouse.move(from.x + 40, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(from.x + 40, from.y + 20, { steps: 4 });
  await a.mouse.move(to.x + 40, to.y + to.height - 3, { steps: 12 });
  await a.mouse.up();
  await a.waitForFunction(() => {
    const row = [...document.querySelectorAll('.guild-channel')].find((li) => li.textContent.includes('notes'));
    const plans = [...document.querySelectorAll('.guild-channel')].find((li) => li.textContent.includes('plans'));
    return row && plans && row.dataset.category === plans.dataset.category;
  }, null, { timeout: 5000 });
  await b.waitForFunction(() => ![...document.querySelectorAll('.guild-channel-name')].some((e) => e.textContent.trim() === 'notes'), null, { timeout: 5000 });
  check(true, 'dragged into Staff, #notes goes private: Bob loses it');

  // Its Permissions tab says Synced; a change by hand makes it Not synced; Sync now.
  await a.hover('.guild-channel:has-text("notes")');
  await a.click('button[aria-label="Edit notes"]');
  await a.click('.settings-tab:has-text("Permissions")');
  await a.waitForSelector('.permissions-sync.synced:has-text("Synced with Staff")');
  check(true, 'Synced with Staff');
  await shot(a, '02-synced');
  await a.click('button[aria-label="Deny Add Reactions"]');
  await a.waitForSelector('.permissions-sync:not(.synced):has-text("Not synced with Staff")');
  check(true, 'a change by hand: Not synced');
  for (const theme of ['dark', 'light', 'slack']) {
    await a.evaluate((t) => (t === 'dark' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', t)), theme);
    await shot(a, `03-not-synced-${theme}`);
  }
  await a.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await a.click('.permissions-sync button:has-text("Sync now")');
  await a.waitForSelector('.permissions-sync.synced');
  check(true, 'Sync now: synced again');
  await a.click('button:has-text("Done")');

  // The category's own Permissions tab: every type's permissions; opening it to Bob's role.
  await a.hover('.guild-category-toggle:has-text("Staff")');
  await a.click('button[aria-label="Edit category Staff"]');
  await a.click('.settings-tab:has-text("Permissions")');
  await a.waitForSelector('text=Private category');
  check(await a.isVisible('[role=radiogroup][aria-label="Connect"]') && await a.isVisible('[role=radiogroup][aria-label="Edit Tasks"]'), 'a category lists voice and list permissions too');
  for (const theme of ['dark', 'light', 'slack']) {
    await a.evaluate((t) => (t === 'dark' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', t)), theme);
    await shot(a, `04-category-permissions-${theme}`);
  }
  await a.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  // Making it public again reaches both synced channels: Bob gets them back.
  await a.click('.private-toggle input');
  await a.waitForSelector('text=Also changed in 2 synced channels.');
  check(true, 'the category change reached 2 synced channels');
  await b.waitForFunction(() => {
    const shown = [...document.querySelectorAll('.guild-channel-name')].map((e) => e.textContent.trim());
    return shown.includes('notes') && shown.includes('plans');
  }, null, { timeout: 5000 });
  check((await names(b, '.guild-category-toggle span')).includes('Staff'), 'Bob sees Staff and its channels again');
  await shot(b, '05-bob-sees-staff');

  console.log('categorypermissions: ok');
} catch (err) {
  console.error('categorypermissions: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
