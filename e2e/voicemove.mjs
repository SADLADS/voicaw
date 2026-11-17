// Moving people between voice channels: Bob is in #lounge; Alice (the guild's owner) drags him
// in the channel list onto #stage, which is full (a user limit of 1, Dan in it), and his app
// joins it by itself (connected, his voice bar names #stage, LiveKit really has him there:
// everyone sees him under #stage). Carol, a plain member, can't drag anyone. The audit log
// says who moved whom. Screenshots mid-drag in the dark, light and Slack themes.
//   node e2e/serve.mjs &   then   node e2e/voicemove.mjs [screenshot dir]
import { launchChrome, signUp, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name, clip) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...(clip && { clip }) });
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

async function createVoiceChannel(page, name) {
  await page.click('.guild-header-button');
  await page.click('text=Create Channel');
  await page.click('label:has-text("Voice")');
  await page.fill('#channel-name', name);
  await page.click('button:has-text("Create channel")');
  await page.waitForSelector(`.guild-channel-link:has-text("${name}")`);
}

const channelRow = (name) => `.guild-channel:has(.guild-channel-name:text-is("${name}"))`;
// Who's under a channel in the list, as the page shows it.
const membersUnder = (page, name) => page.evaluate((channel) => {
  const row = [...document.querySelectorAll('.guild-channel')].find((li) => li.querySelector('.guild-channel-name')?.textContent === channel);
  let next = row?.nextElementSibling;
  while (next && !next.classList.contains('guild-channel-voice') && !next.classList.contains('guild-channel')) next = next.nextElementSibling;
  if (!next?.classList.contains('guild-channel-voice')) return [];
  return [...next.querySelectorAll('.voice-member-name')].map((el) => el.textContent);
}, name);

async function waitForMembers(page, channel, expected) {
  const until = Date.now() + 20000;
  let seen;
  while (Date.now() < until) {
    seen = await membersUnder(page, channel);
    if (JSON.stringify([...seen].sort()) === JSON.stringify([...expected].sort())) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${channel}: expected ${expected.join(', ') || 'nobody'}, saw ${seen.join(', ') || 'nobody'}`);
}

const centre = async (page, selector) => {
  const box = await (await page.$(selector)).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const dan = await signUp(browser, 'dan');
  const [a, b, c, d] = [alice.page, bob.page, carol.page, dan.page];
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c], ['dan', d]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} error]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Move Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await createVoiceChannel(a, 'lounge');
  await createVoiceChannel(a, 'stage');

  // #stage takes one person.
  await a.hover(channelRow('stage'));
  await a.click(`${channelRow('stage')} button[aria-label="Edit stage"]`);
  await a.waitForSelector('[role="dialog"]');
  const limit = await a.$('#channel-user-limit');
  if (!limit) throw new Error('no user limit control in the channel dialog');
  await limit.evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await a.click('[role="dialog"] button:has-text("Save")');
  await a.waitForSelector(`${channelRow('stage')} .guild-channel-limit`);

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  for (const page of [b, c, d]) await joinWith(page, link);

  // Dan fills #stage, Bob goes into #lounge.
  await d.click('.guild-channel-link:has-text("stage")');
  await d.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await waitForMembers(a, 'lounge', [bob.name]);
  await waitForMembers(a, 'stage', [dan.name]);
  await c.waitForSelector(`${channelRow('stage')} .guild-channel-limit.full`);

  // Carol isn't an administrator: nobody is draggable for her.
  await waitForMembers(c, 'lounge', [bob.name]);
  if (await c.$('[data-voice-draggable]')) throw new Error('carol can drag people');
  console.log('carol (member): nobody draggable');

  // Alice drags Bob onto #stage.
  const bobRow = `.voice-member:has(.voice-member-name:text-is("${bob.name}"))`;
  const from = await centre(a, bobRow);
  const to = await centre(a, channelRow('stage'));
  await a.mouse.move(from.x, from.y);
  await a.mouse.down();
  await a.mouse.move(from.x, from.y + 8, { steps: 2 });
  await a.mouse.move(to.x, to.y, { steps: 8 });
  await a.waitForSelector(`${channelRow('stage')}.voice-drop-target`);
  await a.waitForSelector('.voice-member-ghost');
  if (!(await a.$eval(bobRow, (el) => el.classList.contains('dragging')))) throw new Error("bob's row isn't dimmed while dragged");
  const sidebarClip = { x: 0, y: 0, width: 420, height: 420 };
  await shot(a, '01-dragging-dark', sidebarClip);
  for (const theme of ['light', 'slack']) {
    await a.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await a.waitForTimeout(100);
    await shot(a, `02-dragging-${theme}`, sidebarClip);
  }
  await a.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await a.mouse.up();
  if (await a.$('.voice-member-ghost')) throw new Error('the ghost stayed after the drop');

  // Bob's app follows: connected in #stage (full, but he was moved), seen there by everyone.
  await waitForMembers(a, 'stage', [dan.name, bob.name]);
  await waitForMembers(a, 'lounge', []);
  await waitForMembers(c, 'stage', [dan.name, bob.name]);
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  const bar = await b.textContent('.voice-bar');
  if (!bar.includes('stage')) throw new Error(`bob's voice bar doesn't name #stage: ${bar}`);
  console.log("bob moved: connected, voice bar:", bar.replace(/\s+/g, ' ').trim().slice(0, 80));
  await shot(a, '03-after-move', sidebarClip);
  await shot(b, '04-bob-after-move');
  // Still there a while later (not taken out after the grace time by mistake).
  await a.waitForTimeout(16000);
  await waitForMembers(a, 'stage', [dan.name, bob.name]);
  await b.waitForSelector('.voice-bar-status.connected');
  console.log('bob still in #stage after 16 s');

  // The audit log says so.
  await a.click('.guild-header-button');
  await a.click('text=Audit Log');
  await a.waitForSelector(`text=moved`);
  const entry = await a.textContent(`[role="dialog"] :text("moved")`);
  console.log('audit log:', entry.replace(/\s+/g, ' ').trim());
  await shot(a, '05-audit-log');
  console.log('OK');
} finally {
  await browser.close();
}
