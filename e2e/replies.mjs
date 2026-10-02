// Replies: clicking a reply's snippet jumps to the message it answers like search and pins do
// (loads older history until it's there, scrolls to it, flashes it), again once loaded, and a
// tap on a phone.
//   node e2e/serve.mjs &   then   node e2e/replies.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const content = (page, text) => page.locator('.dm-message-content', { hasText: exactly(text) });
const row = (page, text) => page.locator('.each-dm-message-wrapper', { has: content(page, text) });
const waitText = (page, text, timeout = 20000) => content(page, text).first().waitFor({ timeout });

async function replyTo(page, text, reply) {
  await row(page, text).scrollIntoViewIfNeeded();
  await row(page, text).hover();
  await row(page, text).locator('.message-menu button:has(svg[data-icon="reply"])').click();
  await send(page, reply);
  await waitText(page, reply);
}

const inView = (page, text) => row(page, text).evaluate((el) => {
  const r = el.getBoundingClientRect();
  const s = document.querySelector('.message-scroller').getBoundingClientRect();
  return r.top >= s.top && r.bottom <= s.bottom;
});
const flashed = (page, text) => row(page, text).evaluate((el) => el.classList.contains('jump-highlight'));
const toBottom = (page) => page.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight; });

const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;

  console.log('computer');
  await openChat(a, bob.id);
  await send(a, 'where shall we meet');
  await waitText(a, 'where shall we meet');
  // Enough after it that bob's first page doesn't include it (as in pins.mjs).
  for (let i = 1; i <= 130; i++) await send(a, `filler ${i}`);
  await waitText(a, 'filler 130');
  await replyTo(a, 'where shall we meet', 'at the station');

  await openChat(b, alice.id);
  await waitText(b, 'at the station');
  check(await row(b, 'where shall we meet').count() === 0, "bob's chat hasn't loaded the replied-to message yet");
  await row(b, 'at the station').locator('.reply-preview').click();
  await row(b, 'where shall we meet').waitFor({ timeout: 20000 });
  await b.waitForTimeout(100);
  check(await inView(b, 'where shall we meet'), 'clicking the snippet loaded older history and scrolled to it');
  check(await flashed(b, 'where shall we meet'), 'and highlights it, as search and pins do');
  await shot(b, '01-reply-jumped');

  await b.waitForTimeout(2200);
  check(!(await flashed(b, 'where shall we meet')), 'the highlight goes after 2s');
  await toBottom(b);
  await row(b, 'at the station').locator('.reply-preview').click();
  await b.waitForTimeout(100);
  check(await inView(b, 'where shall we meet') && await flashed(b, 'where shall we meet'), 'again once it is loaded');

  console.log('phone');
  await openChat(a, carol.id);
  await send(a, 'did you bring the map');
  await waitText(a, 'did you bring the map');
  for (let i = 1; i <= 30; i++) await send(a, `more ${i}`);
  await waitText(a, 'more 30');
  await replyTo(a, 'did you bring the map', 'never mind, found it');

  await openChat(c, alice.id);
  await waitText(c, 'never mind, found it');
  await toBottom(c);
  await row(c, 'never mind, found it').locator('.reply-preview').tap();
  await row(c, 'did you bring the map').waitFor({ timeout: 20000 });
  await c.waitForTimeout(100);
  check(await inView(c, 'did you bring the map') && await flashed(c, 'did you bring the map'), 'a tap on a phone jumps and highlights too');
  await shot(c, '02-phone-reply-jumped');

  console.log('all good');
} finally {
  await browser.close();
}
