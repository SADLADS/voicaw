// A grouped message's hover time: inside the avatar's column, ending at its right edge, so the
// text starts as far from the time (12px) as from a picture, for a long time ("12:05 PM") too.
//   node e2e/serve.mjs &   then   node e2e/hovertime.mjs [dir]
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await openChat(alice.page, bob.id);
  await send(alice.page, 'first line');
  await send(alice.page, 'no i have not');
  const page = alice.page;
  const row = page.locator('.each-dm-message-wrapper.grouped', { hasText: 'no i have not' });
  await row.waitFor({ timeout: 10000 });
  await row.hover();

  for (const time of ['12:05 PM', '9:05 AM']) {
    // The longest and a short time, whatever the clock says now.
    const m = await row.evaluate((el, time) => {
      const small = el.querySelector('.message-hover-time');
      small.textContent = time;
      const range = document.createRange();
      range.selectNodeContents(small);
      const t = range.getBoundingClientRect();
      const msg = el.querySelector('.dm-message').getBoundingClientRect();
      const text = el.querySelector('.dm-message-content').getBoundingClientRect();
      return { visible: getComputedStyle(small).visibility, left: t.left - msg.left, right: t.right - msg.left, gap: text.left - t.right };
    }, time);
    console.log(time, JSON.stringify(m));
    if (m.visible !== 'visible') throw new Error('time not shown on hover');
    if (Math.abs(m.gap - 12) > 1) throw new Error(`${time}: ${m.gap.toFixed(1)}px before the text, not 12`);
    if (m.left < 0) throw new Error(`${time}: starts outside the message`);
  }
  if (dir) await row.screenshot({ path: `${dir}/hovertime.png` });
  console.log('hovertime: ok');
} catch (err) {
  console.error('hovertime: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
