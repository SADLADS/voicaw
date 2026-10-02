// Typing indicator: "Alice is typing…" with bouncing dots in a DM (gone as soon as her message
// arrives, never over the last message), two people in a guild channel, a phone, and Settings →
// Privacy's "Let others see when I'm typing" turned off.
//   node e2e/serve.mjs &   then   node e2e/typing.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, BASE, devices } from './helpers.mjs';

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
const indicatorText = (page) => page.$eval('.typing-indicator', (el) => el.textContent.trim());

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const [a, b, c] = [alice.page, bob.page, carol.page];

  // DM: a few messages first, so the indicator has something to sit under.
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  for (let i = 1; i <= 20; i++) await send(a, `message ${i}`);
  await b.waitForSelector('.dm-message-content:has-text("message 20")');
  check(await indicatorText(b) === '', 'nothing shown before anyone types');

  await a.click('#dm-input');
  await a.keyboard.type('hello the');
  await b.waitForSelector('.typing-indicator .typing-dots', { timeout: 5000 });
  check(await indicatorText(b) === `${alice.name} is typing…`, `Bob sees "${alice.name} is typing…"`);
  check(await indicatorText(a) === '', "Alice doesn't see herself typing");
  const dot = await b.$eval('.typing-dots span', (el) => getComputedStyle(el).animationName);
  check(dot === 'typing-dot', 'the dots are animated');
  // It sits in the room under the last message, not over it.
  const overlap = await b.evaluate(() => {
    const rows = document.querySelectorAll('.message-scroller .each-dm-message-wrapper');
    const last = rows[rows.length - 1].getBoundingClientRect();
    return last.bottom - document.querySelector('.typing-indicator').getBoundingClientRect().top;
  });
  check(overlap <= 0, `doesn't cover the last message (${overlap.toFixed(1)}px)`);
  const box = await b.$eval('.typing-indicator', (el) => {
    const r = el.getBoundingClientRect();
    const composer = document.querySelector('.dm-chat-wrapper').getBoundingClientRect();
    return { gap: composer.top - r.bottom };
  });
  check(box.gap >= 0 && box.gap < 2, 'right above the message box');
  await shot(b, '01-dm-typing');

  await a.keyboard.type('re');
  await a.keyboard.press('Enter');
  await b.waitForSelector('.dm-message-content:has-text("hello there")');
  await b.waitForTimeout(100);
  check(await indicatorText(b) === '', 'gone as soon as the message arrives');

  // A guild channel: two people typing; Carol watches on a phone.
  const guild = await api(a, 'POST', '/guilds', { name: 'Typing' });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  await api(c, 'POST', `/invites/${invite.code}`);
  for (const page of [a, b, c]) {
    await page.goto(`${BASE}/guild/${guild.id}`);
    await page.waitForSelector('#dm-input');
  }
  await a.click('#dm-input');
  await a.keyboard.type('one');
  await b.click('#dm-input');
  await b.keyboard.type('two');
  await c.waitForFunction(() => document.querySelector('.typing-indicator')?.textContent.includes('are typing'), null, { timeout: 5000 });
  check(await indicatorText(c) === `${alice.name} and ${bob.name} are typing…`, 'two typers named on the phone');
  await shot(c, '02-phone-two-typing');
  await shot(a, '03-guild-bob-typing');

  // The typing line stops after a while without more typing (10s).
  await c.waitForFunction(() => document.querySelector('.typing-indicator')?.textContent === '', null, { timeout: 14000 });
  check(true, 'gone after they stop typing');

  // Privacy: turned off, Bob types without anyone seeing.
  await b.goto(`${BASE}/settings`);
  await b.click('.settings-nav-item:has-text("Privacy")');
  const toggle = b.getByLabel("Let others see when I'm typing");
  check(await toggle.isChecked(), 'on by default');
  await shot(b, '04-settings-privacy');
  await toggle.uncheck();
  await b.goto(`${BASE}/guild/${guild.id}`);
  await b.waitForSelector('#dm-input');
  await b.click('#dm-input');
  await b.keyboard.type('secret typing');
  await a.waitForTimeout(2500);
  check(await indicatorText(a) === '', 'with it off, nobody sees Bob typing');

  console.log('typing: ok');
} catch (err) {
  console.error('typing: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
