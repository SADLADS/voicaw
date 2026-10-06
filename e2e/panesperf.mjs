// How smooth the phone panes' swipe is (hooks/useSwipePanes.js): a phone with a slowed-down
// CPU drags and flicks between a long chat and the list, a few times each way, while the page
// records every frame and long task. Prints, per gesture, the longest gap between frames and
// how many frames missed (over 1.5 frames at 60 Hz), split into the drag (finger down) and the
// slide after letting go, plus the main thread's script / style / layout time (CDP metrics).
//   node e2e/serve.mjs &   then   node e2e/panesperf.mjs [runs] [cpu slowdown]
// Numbers from the dev server include React's development overhead; measure a production
// build as embedperf.mjs says (E2E_WEB_PORT=<vite preview's port>).
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const RUNS = Number(process.argv[2] || 5);
const SLOWDOWN = Number(process.argv[3] || 4);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;
const settle = (page) => page.waitForFunction(() => !document.querySelector('.main-wrapper.panes-moving'), null, { timeout: 5000 });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  const carol = await signUp(browser, 'carol');
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 60; i++) await send(alice.page, `message number ${i}\nwith a **second** line and a link https://example.com/${i} :smile:`);
  await openChat(carol.page, bob.id);
  await send(carol.page, 'hello from carol');

  const page = bob.page;
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 60');
  await settle(page);
  const { width, height } = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });

  await page.evaluate(() => {
    window.__perf = { frames: [], long: [], end: 0 };
    const loop = (t) => { window.__perf.frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: false });
    document.addEventListener('touchend', () => { window.__perf.end = performance.now(); }, true);
  });

  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

  async function gesture({ x, dx, steps, ms }) {
    await page.evaluate(() => { window.__perf.frames = []; window.__perf.long = []; window.__perf.start = performance.now(); });
    const before = await metrics();
    const y = height * 0.5;
    await touch('touchStart', x, y);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x + (dx * i) / steps, y);
      await new Promise((r) => setTimeout(r, ms));
    }
    await touch('touchEnd');
    await settle(page);
    await page.waitForTimeout(300);
    const after = await metrics();
    const p = await page.evaluate(() => window.__perf);
    const gaps = (from, to) => {
      const fs = p.frames.filter((t) => t >= from && t <= to);
      const out = [];
      for (let i = 1; i < fs.length; i++) out.push(fs[i] - fs[i - 1]);
      return out;
    };
    const drag = gaps(p.start, p.end);
    const slide = gaps(p.end, p.end + 600);
    const firstAfter = p.frames.find((t) => t > p.end);
    const ms2 = (k) => (after[k] - before[k]) * 1000;
    return {
      dragMax: Math.max(0, ...drag), dragMissed: drag.filter((g) => g > 25).length,
      slideMax: Math.max(0, ...slide), slideMissed: slide.filter((g) => g > 25).length,
      firstFrame: firstAfter - p.end,
      longest: Math.max(0, ...p.long.map((l) => l.ms)),
      script: ms2('ScriptDuration'), style: ms2('RecalcStyleDuration'), layout: ms2('LayoutDuration'), task: ms2('TaskDuration'),
    };
  }

  const kinds = {
    'chat -> list (slow drag)': { x: 30, dx: width * 0.7, steps: 20, ms: 16 },
    'list -> chat (slow drag)': { x: width - 30, dx: -width * 0.7, steps: 20, ms: 16 },
    'chat -> list (flick)': { x: 30, dx: width * 0.3, steps: 5, ms: 8 },
    'list -> chat (flick)': { x: width - 30, dx: -width * 0.3, steps: 5, ms: 8 },
  };
  if (process.env.TRACE) {
    // TRACE=<file.json>: one drag each way traced first (open it in DevTools' Performance tab).
    await browser.startTracing(page, { path: process.env.TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'viz', 'blink'] });
    await gesture(kinds['chat -> list (slow drag)']);
    await gesture(kinds['list -> chat (slow drag)']);
    await browser.stopTracing();
  }
  const results = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
  for (let r = 0; r < RUNS; r++) {
    results['chat -> list (slow drag)'].push(await gesture(kinds['chat -> list (slow drag)']));
    results['list -> chat (slow drag)'].push(await gesture(kinds['list -> chat (slow drag)']));
    results['chat -> list (flick)'].push(await gesture(kinds['chat -> list (flick)']));
    results['list -> chat (flick)'].push(await gesture(kinds['list -> chat (flick)']));
  }
  console.log(`CPU ${SLOWDOWN}x slower, ${RUNS} runs each, medians (ms):`);
  for (const [name, rs] of Object.entries(results)) {
    const m = (k) => round(median(rs.map((r) => r[k])));
    console.log(`${name.padEnd(26)} drag: max gap ${m('dragMax')}, missed ${m('dragMissed')} | after release: first frame ${m('firstFrame')}, max gap ${m('slideMax')}, missed ${m('slideMissed')} | longest task ${m('longest')} | script ${m('script')} style ${m('style')} layout ${m('layout')} task ${m('task')}`);
  }
} finally {
  await browser.close();
}
