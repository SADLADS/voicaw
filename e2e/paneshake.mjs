// The phone panes' slide on slow frames (hooks/useSwipePanes.js): with every frame held to
// ~30 fps (an iPhone in Low Power Mode, or a phone busy drawing the chat it's sliding in),
// tapping a conversation slides the chat in without ever turning back. Stepping the spring per
// frame made it shake back and forth there for most of a second.
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
      const start = performance.now();
      while (performance.now() - start < 30) { /* a slow frame */ }
      const t = document.querySelector('.slidey .main-content-wrapper')?.style.transform;
      const m = t && /translate3d\(([-\d.]+)px/.exec(t);
      if (m) window.__xs.push(Number(m[1]));
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
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
