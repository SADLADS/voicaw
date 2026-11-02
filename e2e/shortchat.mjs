// A chat with few messages sits at the bottom, by the message box, like Discord's; once it's
// longer than the view it scrolls as before (all the way up to the first message), on a computer
// and a phone.
//   node e2e/serve.mjs &   then   node e2e/shortchat.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

// Where the messages are in the scroller: the gap above the first row and below the last.
const measure = (page) => page.evaluate(() => {
  const scroller = document.querySelector('.message-scroller');
  const rows = scroller.querySelectorAll('.each-dm-message-wrapper');
  const box = scroller.getBoundingClientRect();
  return {
    above: rows[0].getBoundingClientRect().top - box.top,
    below: box.bottom - rows[rows.length - 1].getBoundingClientRect().bottom,
    overflows: scroller.scrollHeight > scroller.clientHeight + 1,
    atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2,
  };
});

const check = (ok, what) => { if (!ok) throw new Error(what); };

async function run(page, label) {
  const guild = await api(page, 'POST', '/guilds', { name: `Short ${label}` });
  const channel = guild.channels[0].id;
  const post = (content) => api(page, 'POST', `/channels/${channel}/messages`, { content });
  await post('first message');
  await post('second message');
  await page.goto(`${BASE}/guild/${guild.id}/${channel}`);
  await page.waitForSelector('.each-dm-message-wrapper:has-text("second message")');
  await page.waitForTimeout(300);
  const short = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/shortchat-${label}-short.png` });
  check(!short.overflows, `${label}: two messages overflow`);
  // Only the list's bottom padding (12px + the typing line) under the last message.
  check(short.below < 60, `${label}: ${Math.round(short.below)}px under the last message`);
  check(short.above > 150, `${label}: messages not at the bottom (${Math.round(short.above)}px above)`);

  // Arriving live while open, until the chat is longer than the view.
  for (let i = 0; i < 40; i++) await post(`filler ${i}`);
  await page.waitForSelector('.each-dm-message-wrapper:has-text("filler 39")');
  await page.waitForTimeout(300);
  const long = await measure(page);
  check(long.overflows && long.atBottom, `${label}: long chat not overflowing at the bottom`);
  await page.evaluate(() => { document.querySelector('.message-scroller').scrollTop = 0; });
  await page.waitForTimeout(200);
  const top = await measure(page);
  check(top.above >= 0 && top.above < 120, `${label}: first message not reachable at the top (${Math.round(top.above)}px)`);
  console.log(`shortchat ${label}: ok (short: ${Math.round(short.above)}px above, ${Math.round(short.below)}px below; long scrolls to the first message)`);
}

const browser = await launchChrome();
let current;
try {
  const desktop = await signUp(browser, 'alice');
  current = desktop.page;
  await run(desktop.page, 'desktop');
  const phone = await signUp(browser, 'bob', devices['Pixel 7']);
  current = phone.page;
  await run(phone.page, 'phone');
} catch (err) {
  console.error('shortchat: FAILED', err.message.split('\n')[0]);
  if (shots && current) await current.screenshot({ path: `${shots}/shortchat-failed.png` });
  process.exitCode = 1;
} finally {
  await browser.close();
}
