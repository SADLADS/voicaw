// The phone panes' slide on slow frames (hooks/useSwipePanes.js): with every frame held to
// ~30 fps (an iPhone in Low Power Mode, or a phone busy drawing the chat it's sliding in),
// tapping a conversation slides the chat in without ever turning back. Stepping the spring per
// frame made it shake back and forth there for most of a second. And a flick's slide keeps
// moving while the page's thread is busy (it runs on the compositor).
//   node e2e/serve.mjs &   then   node e2e/paneshake.mjs
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello');

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=hello');
  await page.click('.chat-recipient-header .pane-back-button');
  await page.waitForFunction(() => document.querySelector('.main-wrapper.pane-list:not(.panes-moving)'));

  // Every frame takes ~33 ms; the chat pane's position is recorded each frame.
  await page.evaluate(() => {
    window.__xs = [];
    const loop = () => {
      if (window.__stop) return;
      const start = performance.now();
      while (performance.now() - start < 30) { /* a slow frame */ }
      // Computed: the slide is a Web Animation, the inline style only where it started.
      const el = document.querySelector('.slidey .main-content-wrapper');
      const t = el && getComputedStyle(el).transform;
      if (t && t !== 'none') window.__xs.push(new DOMMatrix(t).m41);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.click(`#dm-sidebar a[href="/dm/${alice.id}"]`);
  await page.waitForFunction(() => document.querySelector('.main-wrapper.pane-content:not(.panes-moving)'), null, { timeout: 5000 });
  const xs = await page.evaluate(() => window.__xs);
  let turns = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1] + 0.5) turns++;
  console.log(`positions: ${xs.map(Math.round).join(' ')}`);
  check(xs.length >= 3, `the chat slid in (${xs.length} frames)`);
  check(turns === 0, `never turned back (${turns} times)`);

  // After a flick the slide runs on the compositor: with the page's thread blocked from the
  // moment the finger lifts, frames still reach the screen (counted from the screencast,
  // which only sends a frame when something changed). Stepped from the page, there was one.
  await page.evaluate(() => { window.__stop = true; });
  const { width, height } = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  const shown = [];
  cdp.on('Page.screencastFrame', (f) => {
    shown.push(Date.now());
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 30 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.addEventListener('touchend', () => setTimeout(() => {
    const start = performance.now();
    while (performance.now() - start < 800) { /* busy */ }
  }), { once: true, capture: true }));
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: height / 2 }] });
  await touch('touchStart', 30);
  for (let i = 1; i <= 5; i++) await touch('touchMove', 30 + (width * 0.3 * i) / 5);
  shown.length = 0;
  const lifted = Date.now();
  await touch('touchEnd');
  await page.waitForTimeout(900);
  const during = shown.filter((t) => t - lifted < 750).length;
  check(during >= 5, `the slide went on with the page's thread busy (${during} frames)`);
  await page.waitForFunction(() => document.querySelector('.main-wrapper.pane-list:not(.panes-moving)'), null, { timeout: 5000 });
  check(true, 'and came to rest on the list');
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
