// Threads in guild text channels: Create Thread from a message's right-click menu (name
// suggested from it), the panel beside the channel (starter message, chat, member list hidden),
// the message's "N messages" line kept live, posting joins (in the channel list, unread there),
// a thread started on its own (the row in the channel, Threads list), archive, a phone (the
// thread covers the channel, Back returns, long press → Create thread).
//   node e2e/serve.mjs &   then   node e2e/threads.mjs [screenshot dir]
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
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Threaded' });
  const general = guild.channels[0];
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await api(carol.page, 'POST', `/invites/${invite.code}`);
  const message = await api(bob.page, 'POST', `/channels/${general.id}/messages`, { content: 'Shall we plan the summer trip?' });

  // Alice starts a thread from Bob's message.
  const a = alice.page;
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector(`[data-msg-id="${message.id}"]`);
  await a.click(`[data-msg-id="${message.id}"] .dm-message-content`, { button: 'right' });
  await a.click('.context-menu >> text=Create Thread');
  const nameInput = a.locator('#thread-name');
  check((await nameInput.inputValue()) === 'Shall we plan the summer trip?', 'the name is suggested from the message');
  await nameInput.fill('Summer trip');
  await shot(a, 'create-dialog');
  await a.click('.vc-dialog >> button:has-text("Create thread")');
  await a.waitForSelector('.thread-pane');
  check(new URL(a.url()).searchParams.has('thread'), 'the thread opens beside the channel (?thread=)');
  check((await a.textContent('.thread-pane-title h5')) === 'Summer trip', 'with its name in the panel header');
  check((await a.textContent('.thread-starter')).includes('Shall we plan the summer trip?'), 'and the message it started from on top');
  check(!(await a.$('.member-list')), 'in the member list\'s place');
  const paneBox = await a.locator('.thread-pane').boundingBox();
  const chatBox = await a.locator('.guild-chat').boundingBox();
  check(paneBox.x >= chatBox.x + chatBox.width - 1 && paneBox.width >= 300, `the panel sits right of the chat (${Math.round(paneBox.width)}px wide)`);
  check((await a.textContent(`[data-msg-id="${message.id}"] .thread-summary`)).includes('No messages yet'), 'the message shows its thread');
  check(await a.locator('.guild-thread', { hasText: 'Summer trip' }).count() === 1, 'the starter has it in the channel list, under #general');

  // Alice writes in the thread: in its own box, not the channel's.
  await a.click('.thread-pane #dm-input');
  await a.keyboard.type('July works for me');
  await a.keyboard.press('Enter');
  await a.waitForSelector('.thread-pane .message-scroller >> text=July works for me');
  check(!(await a.locator('.guild-chat .message-scroller >> text=July works for me').count()), 'the message went into the thread only');
  await a.waitForFunction((id) => document.querySelector(`[data-msg-id="${id}"] .thread-summary-count`)?.textContent === '1 message', message.id);
  check(true, 'the "N messages" line counted it');
  await a.mouse.move(400, 400);
  await shot(a, 'thread-open');

  // Bob sees the line on his message, opens the thread from it and replies: he joins.
  const b = bob.page;
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector(`[data-msg-id="${message.id}"] .thread-summary`);
  check(!(await b.locator('.guild-thread').count()), "Bob hasn't joined: not in his channel list");
  await b.click(`[data-msg-id="${message.id}"] .thread-summary`);
  await b.waitForSelector('.thread-pane >> text=July works for me');
  check(await b.locator('.thread-pane-join').count() === 1, 'he gets a Join button');
  await b.click('.thread-pane #dm-input');
  await b.keyboard.type('August is better');
  await b.keyboard.press('Enter');
  await b.waitForSelector('.guild-thread >> text=Summer trip');
  check(await b.locator('.thread-pane-join').count() === 0, 'replying joined him (in his list, no Join button)');
  await a.waitForSelector('.thread-pane >> text=August is better');
  check(true, 'Alice sees his reply live in the thread');

  // Alice closes the thread; Bob writes again: the thread is unread in her list.
  await a.click('.thread-pane [aria-label="Close thread"]');
  await a.waitForFunction(() => !document.querySelector('.thread-pane'));
  check(!new URL(a.url()).searchParams.has('thread'), 'closing leaves just the channel');
  check(await a.locator('.member-list').count() === 1, 'and the member list comes back');
  await b.keyboard.type('Or September?');
  await b.keyboard.press('Enter');
  await a.waitForSelector('.guild-thread.unread');
  check(true, 'a new thread message marks it unread in Alice\'s list');
  check(!(await a.locator('.guild-channel.unread', { hasText: 'general' }).count()), 'not #general');
  await a.click('.guild-thread-link');
  await a.waitForSelector('.thread-pane >> text=Or September?');
  await a.waitForFunction(() => !document.querySelector('.guild-thread.unread'));
  check(true, 'opening it from the list reads it');

  // A thread started on its own, from the Threads list.
  await a.click('.threads-button');
  await a.waitForSelector('.threads-panel >> text=Summer trip');
  await shot(a, 'threads-list');
  await a.click('.threads-panel-create');
  await a.fill('#thread-name', 'Random ideas');
  await a.click('.vc-dialog >> button:has-text("Create thread")');
  await a.waitForFunction(() => document.querySelector('.thread-pane-title h5')?.textContent === 'Random ideas');
  await b.waitForSelector('.thread-start-notice >> text=Random ideas');
  check((await b.textContent('.thread-start-notice')).includes('started a thread'), 'the channel gets a "started a thread" row');
  await b.click('.thread-start-notice .thread-start-link');
  await b.waitForSelector('.threads-panel >> text=Random ideas');
  check(true, '"See all threads" opens the list');
  await b.keyboard.press('Escape');

  // Archiving: out of the channel list, Archived in the list and the panel.
  await a.click('.thread-pane-menu-button');
  await a.click('.context-menu >> text=Archive Thread');
  await a.waitForSelector('.thread-pane-archived');
  check(!(await a.locator('.guild-thread', { hasText: 'Random ideas' }).count()), 'an archived thread leaves the channel list');
  await a.click('.threads-button');
  await a.waitForSelector('.threads-panel .thread-list-heading >> text=Archived');
  check(true, 'and is under Archived in the thread list');
  await a.keyboard.press('Escape');

  // Carol, on a phone: the thread covers the channel; Back returns; long press starts one.
  const c = carol.page;
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector(`[data-msg-id="${message.id}"] .thread-summary`);
  await c.tap(`[data-msg-id="${message.id}"] .thread-summary`);
  await c.waitForSelector('.thread-pane.mobile >> text=Or September?');
  const box = await c.locator('.thread-pane').boundingBox();
  const { width } = c.viewportSize();
  check(box.x === 0 && Math.round(box.width) === width, `on a phone the thread covers the channel (${Math.round(box.width)} of ${width})`);
  await shot(c, 'phone-thread');
  await c.tap('.thread-pane [aria-label="Back to #general"]');
  await c.waitForFunction(() => !document.querySelector('.thread-pane'));
  check(true, 'Back returns to the channel');
  const own = await api(c, 'POST', `/channels/${general.id}/messages`, { content: 'Phone thread please' });
  await c.waitForSelector(`[data-msg-id="${own.id}"]`);
  const target = await c.locator(`[data-msg-id="${own.id}"] .dm-message-content`).boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const point = { x: target.x + 20, y: target.y + target.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await new Promise((r) => setTimeout(r, 700));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.action-sheet >> text=Create thread');
  await shot(c, 'phone-sheet');
  await c.tap('.action-sheet >> text=Create thread');
  await c.waitForSelector('#thread-name');
  await c.tap('.vc-dialog >> button:has-text("Create thread")');
  await c.waitForFunction(() => document.querySelector('.thread-pane-title h5')?.textContent === 'Phone thread please');
  check(true, 'a long press starts a thread on a phone too');

  console.log('threads: ok');
} catch (err) {
  console.error('threads: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
