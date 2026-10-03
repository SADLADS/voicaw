// Tapping a message on a phone: a brief highlight in the hover colour that fades away (like
// jumping to a message, which flashes yellow), not a highlight that stays until the next tap
// (touch screens keep :hover on the last thing tapped). A long press still keeps its message
// highlighted while the action sheet is open; a computer still highlights on hover, no flash.
//   node e2e/serve.mjs &   then   node e2e/taphighlight.mjs [screenshot dir]
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

const background = (page, text) => row(page, text).evaluate((el) => getComputedStyle(el).backgroundColor);
const hasClass = (page, text, name) => row(page, text).evaluate((el, n) => el.classList.contains(n), name);
// --vc-bg-hover as a computed colour, to compare with a row's background.
const hoverColour = (page) => page.evaluate(() => {
  const probe = document.createElement('div');
  probe.style.backgroundColor = 'var(--vc-bg-hover)';
  document.body.appendChild(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
});

async function longPress(page, locator) {
  const box = await locator.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'tap me');
  await send(alice.page, 'hold me');
  await waitText(alice.page, 'hold me');

  console.log('phone');
  const p = bob.page;
  await openChat(p, alice.id);
  await waitText(p, 'hold me');
  check(await p.evaluate(() => matchMedia('(hover: none)').matches), 'the phone has no hover');
  const hover = await hoverColour(p);
  const plain = await background(p, 'tap me'); // a row's own background (--vc-bg-subtle)

  await row(p, 'tap me').tap();
  check(await hasClass(p, 'tap me', 'tap-highlight'), 'a tap flashes the message');
  const start = await background(p, 'tap me');
  check(start === hover, `it starts in the hover colour (${start})`);
  await shot(p, '01-phone-tapped');
  await p.waitForTimeout(1000);
  const middle = await background(p, 'tap me');
  check(middle !== plain && middle !== start, `and fades (${middle} a second in, ${plain} at rest)`);
  await p.waitForTimeout(1300);
  check(!await hasClass(p, 'tap me', 'tap-highlight'), 'the flash class is gone after 2 s');
  check(await background(p, 'tap me') === plain, 'and the message is back to its own background');
  await shot(p, '02-phone-after');

  // A pointer resting on it (what a phone leaves after a tap) doesn't highlight it either.
  await row(p, 'tap me').hover();
  check(await background(p, 'tap me') === plain, ':hover doesn\'t highlight on a phone');

  // Two taps in a row restart it.
  await row(p, 'tap me').tap();
  await p.waitForTimeout(1500);
  await row(p, 'tap me').tap();
  await p.waitForTimeout(800);
  check(await hasClass(p, 'tap me', 'tap-highlight'), 'a second tap restarts the flash');
  await p.waitForTimeout(1500);

  await longPress(p, row(p, 'hold me'));
  await p.locator('.action-sheet').waitFor({ timeout: 5000 });
  check(!await hasClass(p, 'hold me', 'tap-highlight'), 'a long press doesn\'t flash');
  check(await hasClass(p, 'hold me', 'focused') && await background(p, 'hold me') === hover,
    'it stays highlighted while the action sheet is open');
  await shot(p, '03-phone-long-press');

  console.log('computer');
  const a = alice.page;
  await row(a, 'tap me').hover();
  check(await background(a, 'tap me') === await hoverColour(a), 'hover still highlights on a computer');
  await row(a, 'tap me').locator('.dm-message-content').click();
  check(!await hasClass(a, 'tap me', 'tap-highlight'), 'a click doesn\'t flash');

  console.log('all good');
} catch (err) {
  console.error('taphighlight: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
