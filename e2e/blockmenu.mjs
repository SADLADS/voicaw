// Block and Report from right-click menus: a person's (a message's author: Block asks first, then
// their messages collapse; Unblock straight away; Report opens the form; none on yourself), a
// webhook's (its name on its message: Block Webhook asks first, its messages collapse, kept after
// a reload, listed in Settings → Blocked users with its guild, Unblock there shows them again;
// "Also block" when reporting one of its messages), the DM list's; a phone's sheet has them too.
//   node e2e/serve.mjs &   then   node e2e/blockmenu.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

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
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const items = (page, sel = '.context-menu') => page.$$eval(`${sel} [role^="menuitem"] .context-menu-label`, (els) => els.map((e) => e.firstChild.textContent));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(bob.page, 'POST', '/guilds', { name: 'Alpha' });
  const general = guild.channels[0];
  const invite = await api(bob.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(alice.page, 'POST', `/invites/${invite.code}`);
  const hook = await api(bob.page, 'POST', `/channels/${general.id}/webhooks`, { name: 'Spam Bot' });
  const postAsHook = (content) => fetch(`${BASE}/api/webhooks/${hook.id}/${hook.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
  });

  const a = alice.page;
  await api(bob.page, 'POST', `/channels/${general.id}/messages`, { content: 'hello from bob' });
  await postAsHook('buy now');
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('.message-author[data-webhook-id]');

  // A person: Block asks first, then their message collapses.
  await a.click(`.message-author:has-text("${bob.name}")`, { button: 'right' });
  await a.waitForSelector('.context-menu');
  check(JSON.stringify(await items(a)) === '["Block","Report","Copy User ID"]', `a person's menu: ${await items(a)}`);
  await shot(a, 'person-menu');
  await a.click('.context-menu >> text=Block');
  await a.waitForSelector(`.vc-dialog[aria-label="Block ${bob.name}?"]`);
  await shot(a, 'block-confirm');
  await a.click('.vc-dialog button:has-text("Block")');
  await a.waitForSelector('.blocked-message:has-text("Blocked message")');
  check(true, 'Block asks first, then their message is collapsed');
  // Blocked: Unblock and Report (the form) from the same place, once it's shown.
  await a.click('.blocked-message button:has-text("Show")');
  await a.click(`.message-author:has-text("${bob.name}")`, { button: 'right' });
  await a.waitForSelector('.context-menu >> text=Unblock');
  await a.click('.context-menu >> text=Report');
  await a.waitForSelector(`.vc-dialog[aria-label="Report ${bob.name}"]`);
  check(true, 'Report opens the report form');
  await a.click('.vc-dialog button:has-text("Cancel")');
  await a.click(`.message-author:has-text("${bob.name}")`, { button: 'right' });
  await a.click('.context-menu >> text=Unblock');
  await a.waitForFunction(() => !document.querySelector('.blocked-message'));
  check(true, 'Unblock needs no asking and shows them again');

  // A webhook: Block Webhook from its name.
  await a.click('.message-author[data-webhook-id]', { button: 'right' });
  await a.waitForSelector('.context-menu');
  check(JSON.stringify(await items(a)) === '["Block Webhook","Copy Webhook ID"]', `a webhook's menu: ${await items(a)}`);
  await shot(a, 'webhook-menu');
  await a.click('.context-menu >> text=Block Webhook');
  await a.click('.vc-dialog button:has-text("Block Webhook")');
  await a.waitForSelector('.blocked-message');
  check(!(await a.$('.message-author[data-webhook-id]')), "the webhook's message is collapsed");
  await postAsHook('buy more');
  await a.waitForFunction(() => document.querySelectorAll('.blocked-message').length === 2);
  check(true, 'and so is its next one, live');
  await a.reload();
  await a.waitForSelector('.blocked-message');
  check((await a.$$('.blocked-message')).length === 2, 'still after a reload');

  // Settings → Blocked users lists it with its guild; Unblock shows its messages again.
  await a.goto(`${BASE}/settings#blocked`);
  await a.waitForSelector('.blocked-users li:has-text("Spam Bot")');
  check(await a.isVisible('.blocked-users li:has-text("Webhook in Alpha")'), 'Settings lists the webhook with its guild');
  await shot(a, 'settings-blocked');
  await a.click('.blocked-users li:has-text("Spam Bot") button:has-text("Unblock")');
  await a.waitForSelector('.blocked-users li:has-text("Spam Bot")', { state: 'detached' });
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('.message-author[data-webhook-id]');
  check(!(await a.$('.blocked-message')), 'unblocked there: its messages are back');

  // Reporting one of its messages can block the webhook too.
  await a.locator('.dm-message-content:has-text("buy more")').click({ button: 'right' });
  await a.click('.context-menu >> text=Report Message');
  await a.click('.vc-dialog label:has-text("Spam or scams")');
  await a.click('.vc-dialog label:has-text("Also block Spam Bot")');
  await a.click('.vc-dialog button:has-text("Send report")');
  await a.waitForSelector('.vc-dialog >> text=Thanks for telling us');
  await a.click('.vc-dialog button:has-text("Done")');
  await a.waitForSelector('.blocked-message');
  check(true, 'Report Message → Also block blocks the webhook');

  // The DM list: a person's menu has Block and Report.
  await api(bob.page, 'POST', '/dm-send', { recipient_id: alice.id, content: 'hi' });
  await a.goto(`${BASE}/dm`);
  await a.click(`.dm-user-list-container .dm-user:has-text("${bob.name}")`, { button: 'right' });
  await a.waitForSelector('.context-menu');
  const dmItems = await items(a);
  check(dmItems.includes('Block') && dmItems.includes('Report') && dmItems.at(-1) === 'Copy User ID', `the DM list's menu: ${dmItems.join(', ')}`);
  await a.keyboard.press('Escape');

  // Phone: holding a conversation, the sheet has them; Block asks first.
  const c = carol.page;
  await api(c, 'POST', '/dm-send', { recipient_id: alice.id, content: 'hey' });
  await c.goto(`${BASE}/dm/${alice.id}`);
  await c.waitForSelector('#dm-input');
  await c.goBack().catch(() => {});
  await c.waitForTimeout(400);
  const row = c.locator('.dm-user-list-container .dm-user').first();
  await row.waitFor();
  const cdp = await c.context().newCDPSession(c);
  const box = await row.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await c.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.context-sheet');
  const sheet = await items(c, '.context-sheet');
  check(sheet.includes('Block') && sheet.includes('Report'), `the phone's sheet: ${sheet.join(', ')}`);
  await c.waitForTimeout(300);
  await shot(c, 'phone-sheet');
  await c.tap('.context-sheet >> text=Block');
  await c.waitForSelector('.vc-dialog button:has-text("Block")');
  await shot(c, 'phone-block-confirm');
  await c.tap('.vc-dialog button:has-text("Block")');
  await c.waitForSelector('.vc-dialog', { state: 'detached' });
  check((await api(c, 'GET', '/blocks')).blocked.includes(alice.id), 'blocked from the sheet');

  console.log('block menu: all good');
} finally {
  await browser.close();
}
