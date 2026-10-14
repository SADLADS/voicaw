// Colour scheme screenshots: the same screens in every theme (THEMES=dark,light,familiar,halloween, the
// default), on a computer and a phone, for comparing colour changes before and after. Nothing is
// checked; each screen is tried on its own and the run ends with which ones worked.
//   login (logged out), dm (a mention of the viewer, a link, the viewer's reaction, an unread
//   DM in the list), guild (rail: active guild, mention badge on another; an unread channel),
//   settings (Privacy: toggles, the active tab), list (a done and a not-done task), poll (the
//   viewer's vote), voice-join (a voice channel's Join Voice), voice-connecting (the voice bar
//   while connecting: the join request is held back), call-incoming (a DM call ringing),
//   menu (the guild icon's right-click menu; a touch-and-hold sheet on the phone).
//   node e2e/serve.mjs &   then   node e2e/colours.mjs [screenshot dir]
// Files are <theme>-<desktop|phone>-<screen>.png.
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, devices, fakeMicArgs, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

// After paint, and after fonts and images have settled.
const settle = async (page, ms = 400) => {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(ms);
};

const results = [];
async function screen(name, fn) {
  try {
    await fn();
    results.push([name, 'ok']);
    console.log(`  ok: ${name}`);
  } catch (err) {
    results.push([name, err.message.split('\n')[0]]);
    console.log(`  FAILED: ${name}: ${err.message.split('\n')[0]}`);
  }
}

// Touch and hold (phone), through CDP: Playwright has no long press.
async function hold(page, locator) {
  const cdp = await page.context().newCDPSession(page);
  const box = await locator.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await page.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const pollOf = (page, question) => page.locator(`.poll:has(.poll-question:text-is("${question}"))`);

const browser = await launchChrome({ args: fakeMicArgs(), ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  // --- Shared setup, once: alice is the viewer. ---
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const dave = await signUp(browser, 'dave');
  const a = alice.page;
  const b = bob.page;

  // The DM: a mention of alice and a link from bob, alice's reply, and her reaction.
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  await b.click('#dm-input');
  await b.keyboard.type(`hey @${alice.name.slice(0, 5)}`);
  await b.waitForSelector('.mention-suggestions');
  await b.keyboard.press('Enter');
  await b.keyboard.type(' are you coming tonight?');
  await b.keyboard.press('Enter');
  await b.keyboard.type('The plan is on https://example.com, have a look');
  await b.keyboard.press('Enter');
  await a.waitForSelector('.dm-message-content a[href^="https://example.com"]', { timeout: 15000 });
  await a.click('#dm-input');
  await a.keyboard.type('Yes, **see you there**');
  await a.keyboard.press('Enter');
  const linkMessage = a.locator('.each-dm-message-wrapper:has(a[href^="https://example.com"])');
  await linkMessage.hover();
  await linkMessage.locator('button[aria-label="Add reaction"]').click();
  await a.fill('input[aria-label="Search emoji"]', 'thumbs up');
  await a.click('.emoji-picker-item >> nth=0');
  await a.waitForSelector('.reaction-chip');
  await a.keyboard.press('Escape');
  // An unread DM from carol, for the list's unread marker.
  await openChat(carol.page, alice.id);
  await carol.page.click('#dm-input');
  await carol.page.keyboard.type('Did you get my message?');
  await carol.page.keyboard.press('Enter');
  await a.waitForTimeout(1000);
  console.log('setup: DM done');

  // Guild "Colour Test": #general (messages), #random (unread), #tasks (list), #polls, Lounge (voice).
  const guild = await api(a, 'POST', '/guilds', { name: 'Colour Test' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(a, 'POST', `/guilds/${guildId}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  const role = await api(a, 'POST', `/guilds/${guildId}/roles`, { name: 'Mods', color: 0xe67e22, hoist: true });
  await api(a, 'PUT', `/guilds/${guildId}/members/${bob.id}/roles`, { roleIds: [role.id ?? role.role?.id] });
  for (const [name, type] of [['random', 'text'], ['tasks', 'list'], ['polls', 'text'], ['Lounge', 'voice']]) {
    await api(a, 'POST', `/guilds/${guildId}/channels`, { name, type });
  }
  const layout = await api(a, 'GET', `/guilds/${guildId}`);
  const channel = (name) => layout.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const general = channel('general');
  const random = channel('random');
  const tasks = channel('tasks');
  const polls = channel('polls');
  const lounge = channel('lounge');
  await api(b, 'POST', `/channels/${general.id}/messages`, { content: 'Welcome to the guild! Rules are in the pins.' });
  await api(a, 'POST', `/channels/${general.id}/messages`, { content: `Thanks <@${bob.id}>, glad to be here. Docs: https://example.com/docs` });
  await api(b, 'POST', `/channels/${general.id}/messages`, { content: `<@${alice.id}> can you review the \`colour\` changes?` });
  await api(b, 'POST', `/channels/${random.id}/messages`, { content: 'Something unread in random' });

  // The task board: one done, one not, one assigned with a due date.
  const t1 = await api(a, 'POST', `/channels/${tasks.id}/tasks`, { title: 'Pick the new palette' });
  await api(a, 'POST', `/channels/${tasks.id}/tasks`, { title: 'Check contrast in light mode' });
  const t3 = await api(a, 'POST', `/channels/${tasks.id}/tasks`, { title: 'Ship it' });
  const taskId = (t) => t.id ?? t.task?.id;
  await api(a, 'PATCH', `/tasks/${taskId(t1)}`, { completed: true });
  await api(a, 'PATCH', `/tasks/${taskId(t3)}`, { assigneeIds: [bob.id], dueDate: '2026-12-01' }).catch((e) => console.log('  (task details:', e.message, ')'));

  // A poll in #polls by bob, alice votes (from the page: votes are made there).
  await b.goto(`${BASE}/guild/${guildId}/${polls.id}`);
  await b.waitForSelector('#dm-input');
  await b.click('.attach-button');
  await b.click('.composer-add-item:has-text("Create poll")');
  await b.fill('#poll-question', 'Which accent colour?');
  await b.fill('input[aria-label="Answer 1"]', 'Blurple');
  await b.fill('input[aria-label="Answer 2"]', 'Teal');
  await b.click('text=+ Add another answer');
  await b.fill('input[aria-label="Answer 3"]', 'Orange');
  await b.click('.vc-dialog button:has-text("Post")');
  await b.waitForSelector('.vc-dialog', { state: 'detached' });
  await a.goto(`${BASE}/guild/${guildId}/${polls.id}`);
  await pollOf(a, 'Which accent colour?').waitFor({ timeout: 10000 });
  await pollOf(a, 'Which accent colour?').locator('.poll-option:has-text("Teal")').click();
  await pollOf(a, 'Which accent colour?').locator('button:text-is("Vote")').click();
  await pollOf(a, 'Which accent colour?').locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
  // Bob votes too, so the results have two answers.
  await pollOf(b, 'Which accent colour?').locator('.poll-option:has-text("Blurple")').click();
  await pollOf(b, 'Which accent colour?').locator('button:text-is("Vote")').click();
  await pollOf(b, 'Which accent colour?').locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
  console.log('setup: guild done');

  // A second guild, by bob, with a mention of alice she never reads: a badge on the rail.
  const other = await api(b, 'POST', '/guilds', { name: 'Side Project' });
  const otherId = other.id ?? other.guild?.id;
  const otherInvite = await api(b, 'POST', `/guilds/${otherId}/invites`, {});
  await api(a, 'POST', `/invites/${otherInvite.code}`);
  const otherGeneral = (await api(b, 'GET', `/guilds/${otherId}`)).channels.find((c) => c.name === 'general');
  await api(b, 'POST', `/channels/${otherGeneral.id}/messages`, { content: `<@${alice.id}> ping` });

  // Dave calls alice for the incoming call: his chat (missed calls pile up there) isn't shot.
  // One call now, so his row is in alice's DM list from the first round on.
  const d = dave.page;
  await openChat(d, alice.id);
  const callButton = `button[aria-label="Call ${alice.name}"]:not([disabled])`;
  const hangUp = async () => {
    await d.click('.call-panel button[aria-label="Hang up"], .voice-bar button[aria-label="Hang up"]', { timeout: 5000 }).catch(() => {});
    await d.waitForSelector('.voice-bar-status', { state: 'detached', timeout: 10000 }).catch(() => {});
  };
  await d.click(callButton);
  await d.waitForTimeout(1500);
  await hangUp();

  // The setup pages are done with; alice's own sessions come next.
  await a.context().close();
  await carol.page.context().close();

  // --- Each theme × device: a fresh context, logged in as alice. ---
  for (const theme of (process.env.THEMES || 'dark,light,familiar,halloween').split(',')) {
    for (const device of ['desktop', 'phone']) {
      const phone = device === 'phone';
      const prefix = `${theme}-${device}`;
      console.log(`${prefix}:`);
      const context = await browser.newContext(phone ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 800 } });
      await context.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* no storage */ } }, theme);
      const p = await context.newPage();
      p.on('dialog', (d) => d.accept());
      const shot = async (name) => {
        await settle(p);
        if (dir) await p.screenshot({ path: `${dir}/${prefix}-${name}.png` });
      };

      await screen(`${prefix}-login`, async () => {
        await p.goto(`${BASE}/`);
        await p.waitForSelector('input[placeholder="Username"]');
        await shot('login');
      });
      await p.goto(`${BASE}/`);
      await p.fill('input[placeholder="Username"]', alice.name);
      await p.fill('input[placeholder="Password"]', alice.password);
      await p.keyboard.press('Enter');
      await p.waitForSelector('#dm-main, .dm-sidebar', { timeout: 30000 });
      await p.waitForLoadState('networkidle');

      await screen(`${prefix}-dm`, async () => {
        await openChat(p, bob.id);
        await p.waitForSelector('.reaction-chip', { timeout: 15000 });
        await p.waitForSelector('.dm-message-content .mention-me');
        await shot('dm');
      });

      await screen(`${prefix}-guild`, async () => {
        await p.goto(`${BASE}/guild/${guildId}/${general.id}`);
        await p.waitForSelector('text=review the');
        await p.waitForSelector('.rail-mention-badge', { state: 'attached', timeout: 10000 });
        if (phone) {
          // The phone shows the chat; the rail and channel list are the pane underneath.
          await shot('guild-chat');
          await p.goBack();
          await p.waitForTimeout(600);
          await p.waitForSelector('.rail-guild', { state: 'visible', timeout: 5000 });
        }
        await shot('guild');
      });

      await screen(`${prefix}-menu`, async () => {
        const icon = p.locator(`.rail-guild[aria-label="Colour Test"]`);
        if (phone) {
          await icon.waitFor({ state: 'visible', timeout: 5000 });
          await hold(p, icon);
          await p.waitForSelector('.context-sheet');
        } else {
          await icon.click({ button: 'right' });
          await p.waitForSelector('.context-menu');
          await p.hover('.context-menu >> text=Notification Settings');
          await p.waitForSelector('.context-submenu');
        }
        await shot('menu');
        await p.keyboard.press('Escape');
      });

      await screen(`${prefix}-settings`, async () => {
        await p.goto(`${BASE}/settings#privacy`);
        await p.waitForSelector('#settings-privacy');
        await shot('settings');
      });

      await screen(`${prefix}-list`, async () => {
        await p.goto(`${BASE}/guild/${guildId}/${tasks.id}`);
        await p.waitForSelector('[data-task-row].done');
        await shot('list');
      });

      await screen(`${prefix}-poll`, async () => {
        await p.goto(`${BASE}/guild/${guildId}/${polls.id}`);
        await pollOf(p, 'Which accent colour?').locator('button:text-is("Remove vote")').waitFor({ timeout: 10000 });
        await shot('poll');
      });

      await screen(`${prefix}-voice-join`, async () => {
        await p.goto(`${BASE}/guild/${guildId}/${lounge.id}`);
        await p.waitForSelector('.voice-view-join');
        await shot('voice-join');
      });

      await screen(`${prefix}-voice-connecting`, async () => {
        // Hold the join request: the voice bar stays on Connecting….
        await p.route('**/api/guilds/*/channels/*/voice', () => {});
        await p.goto(`${BASE}/guild/${guildId}/${lounge.id}`);
        await p.click('.voice-view-join');
        await p.waitForSelector('.voice-bar-status.connecting', { state: 'attached', timeout: 10000 });
        await shot('voice-connecting');
        if (phone) {
          // On the phone the voice bar is on the list pane.
          await p.goBack();
          await p.waitForTimeout(600);
          await shot('voice-connecting-list');
        }
      });
      // A new page drops the held request (and the voice connection with it).
      await p.close();
      const q = await context.newPage();
      q.on('dialog', (d) => d.accept());

      await screen(`${prefix}-call-incoming`, async () => {
        await q.goto(`${BASE}/dm/${bob.id}`);
        await q.waitForSelector('#dm-input');
        await d.waitForSelector(callButton, { timeout: 10000 });
        await d.click(callButton);
        await q.waitForSelector('.incoming-call button[aria-label="Accept"]', { timeout: 15000 });
        await settle(q);
        if (dir) await q.screenshot({ path: `${dir}/${prefix}-call-incoming.png` });
      });
      // Dave hangs up before the next round.
      await hangUp();
      await q.waitForSelector('.incoming-call', { state: 'detached', timeout: 10000 }).catch(() => {});
      await context.close();
    }
  }
} catch (err) {
  console.error('colours: setup FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
const failed = results.filter(([, r]) => r !== 'ok');
console.log(`colours: ${results.length - failed.length}/${results.length} screens${failed.length ? `; failed: ${failed.map(([n]) => n).join(', ')}` : ''}`);
if (failed.length) process.exitCode = 1;
