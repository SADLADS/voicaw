// How soon the phone panes start sliding (hooks/useSwipePanes.js) after a tap on the header's
// back arrow or a conversation in the list, next to a flick for comparison: a phone with a
// slowed-down CPU and a long chat. Prints, per gesture, the median time from the finger lifting
// to the slide's first frame (its Web Animation's start time) and the longest task meanwhile.
//   node e2e/serve.mjs &   then   node e2e/panestap.mjs [runs] [cpu slowdown]
// Numbers from the dev server include React's development overhead; measure a production
// build as embedperf.mjs says (E2E_WEB_PORT=<vite preview's port>).
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const RUNS = Number(process.argv[2] || 5);
const SLOWDOWN = Number(process.argv[3] || 4);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const settled = (page, pane) => page.waitForFunction((p) => document.querySelector(`.main-wrapper.pane-${p}:not(.panes-moving)`), pane, { timeout: 5000 });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 60; i++) await send(alice.page, `message number ${i}\nwith a **second** line and a link https://example.com/${i} :smile:`);

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 60');
  await settled(page, 'content');
  const { width, height } = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

  await page.evaluate(() => {
    window.__tap = { lifted: 0, long: [] };
    document.addEventListener('touchend', (e) => { window.__tap.lifted = e.timeStamp; }, true);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__tap.long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask' });
  });

  // Runs `act`, waits for the panes to come to rest on `pane`; the slide's start and long tasks.
  async function measure(act, pane) {
    await page.evaluate(() => {
      window.__tap.long = [];
      window.__tap.start = null;
      const poll = () => {
        const anim = document.getAnimations().find((a) => a.effect?.target?.classList?.contains('main-content-wrapper'));
        if (anim?.startTime != null) window.__tap.start = anim.startTime;
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
    await act();
    await settled(page, pane);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => window.__tap);
    const during = r.long.filter((l) => l.start >= r.lifted - 5);
    return { delay: r.start - r.lifted, longest: Math.max(0, ...during.map((l) => l.ms)) };
  }

  const tapAt = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    const x = box.x + Math.min(box.width / 2, 60);
    const y = box.y + box.height / 2;
    await touch('touchStart', x, y);
    await new Promise((r) => setTimeout(r, 80)); // a finger's tap
    await touch('touchEnd');
  };
  const flick = async (x, dx) => {
    const y = height * 0.5;
    await touch('touchStart', x, y);
    for (let i = 1; i <= 5; i++) await touch('touchMove', x + (dx * i) / 5, y);
    await touch('touchEnd');
  };

  const results = { 'back arrow': [], 'conversation': [], 'flick to list': [], 'flick to chat': [] };
  for (let r = 0; r < RUNS; r++) {
    results['back arrow'].push(await measure(() => tapAt('.chat-recipient-header .pane-back-button'), 'list'));
    results.conversation.push(await measure(() => tapAt(`#dm-sidebar a[href="/dm/${alice.id}"]`), 'content'));
    results['flick to list'].push(await measure(() => flick(30, width * 0.3), 'list'));
    results['flick to chat'].push(await measure(() => flick(width - 30, -width * 0.3), 'content'));
  }
  console.log(`CPU ${SLOWDOWN}x slower, ${RUNS} runs each, medians (ms):`);
  for (const [name, rs] of Object.entries(results)) {
    console.log(`${name.padEnd(14)} slide starts after ${Math.round(median(rs.map((x) => x.delay)))} | longest task ${Math.round(median(rs.map((x) => x.longest)))}`);
  }
} finally {
  await browser.close();
}
