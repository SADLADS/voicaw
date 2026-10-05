// Opening a chat focuses the message box on a computer, ready to type: a DM by link, another
// DM from the list, a guild channel, a thread beside it; not on a phone (it would open the
// keyboard), and not while another text box has the focus.
//   node e2e/serve.mjs &   then   node e2e/focus.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
// Which message box has the focus: its aria-label, or null.
const focusedBox = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el?.id === 'dm-input' ? el.getAttribute('aria-label') : null;
});
const settle = (page) => page.waitForTimeout(300);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol');
  const dave = await signUp(browser, 'dave', { ...devices['Pixel 7'] });
  const a = alice.page;

  // A DM opened by its link, then another from the list: typing goes straight in.
  await openChat(a, bob.id);
  await settle(a);
  check(await focusedBox(a) === `Message ${bob.name}`, 'a DM opened by link: its box has the focus');
  await a.click(`.dm-user:has-text("${carol.name}")`);
  await a.waitForSelector(`#dm-input[aria-label="Message ${carol.name}"]`);
  await settle(a);
  check(await focusedBox(a) === `Message ${carol.name}`, 'another DM from the list: its box has the focus');
  await a.keyboard.type('typed without clicking');
  check((await a.textContent('#dm-input')).includes('typed without clicking'), 'typing goes into the box');
  if (dir) await a.screenshot({ path: `${dir}/focus-dm.png` });

  // Guild channels, and a thread beside one.
  const guild = await api(a, 'POST', '/guilds', { name: 'Focus' });
  const general = guild.channels[0];
  await api(a, 'POST', `/guilds/${guild.id}/channels`, { name: 'random', type: 'text' });
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  await settle(a);
  check(/general/.test(await focusedBox(a) ?? ''), 'a guild channel by link: its box has the focus');
  await a.click('.guild-channel-link:has-text("random")');
  await a.waitForSelector('.guild-channel.active:has-text("random")');
  await settle(a);
  check(/random/.test(await focusedBox(a) ?? ''), 'another channel from the list: its box has the focus');

  const message = await api(a, 'POST', `/channels/${general.id}/messages`, { content: 'Thread here' });
  const thread = await api(a, 'POST', `/channels/${general.id}/threads`, { name: 'Side talk', messageId: message.id });
  {
    await a.goto(`${BASE}/guild/${guild.id}/${general.id}?thread=${thread.id}`);
    await a.waitForSelector('.thread-pane #dm-input');
    await settle(a);
    check(await a.evaluate(() => document.activeElement?.closest('.thread-pane') != null), 'a thread opened beside the channel: its box has the focus');
  }

  // A search box left with the focus keeps it when the chat changes underneath.
  await openChat(a, bob.id);
  await a.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'stand-in-search';
    document.body.append(input);
    input.focus();
  });
  await a.evaluate(() => document.querySelector(`.dm-user`)?.click());
  await settle(a);
  check(await a.evaluate(() => document.activeElement?.id === 'stand-in-search'), "another text box with the focus keeps it");

  // A phone: no focus, so no keyboard popping up.
  await openChat(dave.page, bob.id);
  await settle(dave.page);
  check(await focusedBox(dave.page) === null, "on a phone the box isn't focused (no keyboard)");
  if (dir) await dave.page.screenshot({ path: `${dir}/focus-phone.png` });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
