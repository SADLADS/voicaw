// Message edit history: a message edited twice (inline, on a computer) shows "(edited)" as a
// button; the other person opens its history there or from the right-click menu: Original,
// Edit, Now, decrypted on the device (DM), checked against the sender's signature (group DM:
// no "unverified"), or plain (guild). A phone opens it from the long-press sheet.
//   node e2e/serve.mjs &   then   node e2e/edithistory.mjs [screenshot dir]
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

const content = (page, text) => page.locator('.dm-message-content', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\(edited\\))?$`) });
const row = (page, text) => page.locator('.each-dm-message-wrapper', { has: content(page, text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });

// Edits the message inline (hover → Edit), replacing its text; `shown` is how it reads then.
async function editTo(page, from, to, shown = to) {
  await row(page, from).hover();
  await row(page, from).locator('.message-menu button:has([data-icon="pen-to-square"])').click();
  await page.waitForSelector('.inline-edit-editor');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(to);
  await page.keyboard.press('Enter');
  await waitText(page, shown);
}

// The open dialog's versions: [[label, text]].
async function versions(page) {
  await page.locator('.edit-history-dialog .edit-history-version').first().waitFor({ timeout: 10000 });
  return page.$$eval('.edit-history-dialog .edit-history-version', (items) => items.map((li) => [
    li.querySelector('.edit-history-meta strong').textContent,
    li.querySelector('.dm-message-content, .vc-hint')?.textContent.trim(),
    Boolean(li.querySelector('.message-signature')),
  ]));
}

const expected = (a, b, c) => JSON.stringify([['Original', a, false], ['Edit', b, false], ['Now', c, false]]);

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.edit-history-dialog', { state: 'detached' });
}

const browser = await launchChrome();
const pages = [];
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  pages.push(a, b, c);

  // ---- DM ----
  console.log('DM');
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  await send(a, 'meet at 5');
  await waitText(a, 'meet at 5');
  await editTo(a, 'meet at 5', 'meet at 6');
  await editTo(a, 'meet at 6', 'meet at 7, bring **snacks**', 'meet at 7, bring snacks');
  await waitText(b, 'meet at 7, bring snacks');
  const edited = row(b, 'meet at 7, bring snacks').locator('button.message-edited-button');
  check(await edited.count() === 1, '"edited" is a button');
  await edited.click();
  const dm = await versions(b);
  check(JSON.stringify(dm) === expected('meet at 5', 'meet at 6', 'meet at 7, bring snacks'), `Bob sees every version, decrypted: ${JSON.stringify(dm)}`);
  await shot(b, '01-dm-history');
  await closeDialog(b);

  // Right-click menu.
  await row(b, 'meet at 7, bring snacks').click({ button: 'right' });
  await b.click('.context-menu >> text=Edit history');
  check((await versions(b)).length === 3, 'the right-click menu opens it too');
  await closeDialog(b);

  // ---- Group DM: old versions are checked against the sender's signature ----
  console.log('group');
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Editors');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupUrl = a.url();
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await send(a, 'agenda: one');
  await waitText(a, 'agenda: one');
  await editTo(a, 'agenda: one', 'agenda: one, two');
  await editTo(a, 'agenda: one, two', 'agenda: one, two, three');
  await b.goto(groupUrl);
  await waitText(b, 'agenda: one, two, three');
  await row(b, 'agenda: one, two, three').locator('button.message-edited-button').click();
  const group = await versions(b);
  check(JSON.stringify(group) === expected('agenda: one', 'agenda: one, two', 'agenda: one, two, three'), `group versions decrypted and verified: ${JSON.stringify(group)}`);
  await shot(b, '02-group-history');
  await closeDialog(b);

  // ---- Phone: the long-press sheet ----
  console.log('phone');
  await c.goto(groupUrl);
  await waitText(c, 'agenda: one, two, three');
  await c.waitForTimeout(500);
  const box = await content(c, 'agenda: one, two, three').boundingBox();
  const cdp = await c.context().newCDPSession(c);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y: box.y + box.height / 2 }] });
  await c.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.action-sheet');
  await shot(c, '03-phone-sheet');
  await c.tap('.action-sheet-items button:has-text("Edit history")');
  check((await versions(c)).length === 3, 'the phone sheet opens it');
  await shot(c, '04-phone-history');
  await c.tap('.edit-history-dialog .btn-secondary');
  await c.waitForSelector('.edit-history-dialog', { state: 'detached' });

  // ---- Guild ----
  console.log('guild');
  const guild = await api(a, 'POST', '/guilds', { name: 'Edits' });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  for (const p of [a, b]) {
    await p.goto(`${BASE}/guild/${guild.id}`);
    await p.waitForSelector('#dm-input');
  }
  await send(a, 'release on monday');
  await waitText(a, 'release on monday');
  await editTo(a, 'release on monday', 'release on tuesday');
  await editTo(a, 'release on tuesday', 'release on wednesday');
  await waitText(b, 'release on wednesday');
  await row(b, 'release on wednesday').locator('button.message-edited-button').click();
  const inGuild = await versions(b);
  check(JSON.stringify(inGuild) === expected('release on monday', 'release on tuesday', 'release on wednesday'), `guild versions: ${JSON.stringify(inGuild)}`);
  await shot(b, '05-guild-history');
  await closeDialog(b);

  // A message never edited has no button.
  await send(b, 'sounds good');
  await waitText(b, 'sounds good');
  check(await row(b, 'sounds good').locator('button.message-edited-button').count() === 0, 'an unedited message has no "edited"');

  console.log('edithistory: ok');
} catch (err) {
  console.error('edithistory: FAILED', err.message.split('\n')[0]);
  for (const [i, p] of pages.entries()) await shot(p, `failed-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
