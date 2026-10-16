// The message box growing while you type (a phone, keyboard up or not) pushes the chat up when
// it's at the bottom, a line at a time, so the newest message stays just above the box; and
// shrinks back when the text goes. Scrolled up, the chat stays where it was.
//   node e2e/serve.mjs &   then   node e2e/composergrow.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const KEYBOARD = 330;

const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = resolve; c.port2.postMessage(0); });
}));

// The newest message's bottom against the box's top, and the chat's gap below.
const measure = async (page) => {
  await settled(page);
  return page.evaluate(() => {
    const s = document.querySelector('.message-scroller');
    const box = document.querySelector('#dm-input').getBoundingClientRect();
    const last = [...document.querySelectorAll('.each-dm-message-wrapper')].at(-1).getBoundingClientRect();
    return {
      boxTop: Math.round(box.top),
      boxHeight: Math.round(box.height),
      lastBottom: Math.round(last.bottom),
      scrollerBottom: Math.round(s.getBoundingClientRect().bottom),
      gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
    };
  });
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 25; i++) await send(alice.page, `message number ${i}`);

  const page = bob.page;
  const viewport = page.viewportSize();
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 25');
  await page.waitForTimeout(500);

  for (const keyboard of [false, true]) {
    const where = keyboard ? 'keyboard up' : 'no keyboard';
    await page.locator('#dm-input').tap();
    if (keyboard) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height - KEYBOARD });
      await page.waitForTimeout(300);
    }
    const start = await measure(page);
    check(start.gap <= 4, `${where}: at the bottom to start (${start.gap}px)`);
    // Typed a word at a time, the way a phone's keyboard sends it; check after every word.
    let worst = 0;
    let lines = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.type(`word${i} `);
      const m = await measure(page);
      worst = Math.max(worst, m.gap);
      lines = Math.max(lines, m.boxHeight);
      if (m.gap > 4) {
        await shot(page, `composergrow-${keyboard ? 'kb' : 'nokb'}-${i}`);
        break;
      }
    }
    const grown = await measure(page);
    check(grown.boxHeight > start.boxHeight + 20, `${where}: the box grew (${start.boxHeight} → ${grown.boxHeight}px)`);
    check(worst <= 4, `${where}: the chat stayed at the bottom while it grew (worst gap ${worst}px)`);
    check(grown.lastBottom <= grown.boxTop + 1 && grown.lastBottom > grown.boxTop - 80,
      `${where}: the newest message is just above the box (${grown.lastBottom} vs ${grown.boxTop})`);
    await shot(page, `composergrow-${keyboard ? 'kb' : 'nokb'}`);
    // Clearing it: the box shrinks, the chat is still at the bottom.
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    const cleared = await measure(page);
    check(cleared.gap <= 4, `${where}: still at the bottom after clearing it (${cleared.gap}px)`);
    if (keyboard) await page.setViewportSize(viewport);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(300);
  }

  // A finger scroll that stops in the blank space under the newest message (it's all in view)
  // is the bottom too: the box growing still pushes the chat up, and new messages follow.
  for (const short of [10, 25]) {
    await page.evaluate((px) => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight - s.clientHeight - px; }, short);
    await page.waitForTimeout(300);
    await page.locator('#dm-input').tap();
    for (let i = 0; i < 25; i++) await page.keyboard.type(`word${i} `);
    const m = await measure(page);
    check(m.gap <= 4 && m.lastBottom <= m.boxTop + 1, `stopped ${short}px short of the bottom: the box growing still pushes the chat up (gap ${m.gap}px)`);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight - s.clientHeight - 20; });
  await page.waitForTimeout(300);
  await send(alice.page, 'one more from alice');
  await page.waitForSelector('text=one more from alice');
  const followed = await measure(page);
  check(followed.gap <= 4, `stopped 20px short: a new message still scrolls the chat (gap ${followed.gap}px)`);
  await shot(page, 'composergrow-short');

  // Scrolled up: the box growing doesn't move the chat back down.
  await page.evaluate(() => { document.querySelector('.message-scroller').scrollTop -= 300; });
  await page.waitForTimeout(300);
  await page.locator('#dm-input').tap();
  const before = await measure(page);
  for (let i = 0; i < 25; i++) await page.keyboard.type(`word${i} `);
  const after = await measure(page);
  check(after.gap >= before.gap - 4, `scrolled up: stays scrolled up while the box grows (${before.gap} → ${after.gap}px)`);
} catch (err) {
  console.error('composergrow e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
