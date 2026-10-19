// How snappy the app is on a phone: a Pixel 7 with a slowed-down CPU opens a long DM, types,
// scrolls, opens the emoji picker and a message's menu, goes back to the list, opens a guild
// channel and switches between channels. For each step it prints the slowest interaction
// (Event Timing, the same measure as INP: input to the next paint), how long until the step's
// result showed, long tasks, the longest gap between frames and the main thread's script /
// style / layout time (CDP metrics).
//   node e2e/serve.mjs &   then   node e2e/mobileperf.mjs [cpu slowdown] [runs]
// Measure a production build (see embedperf.mjs): the dev server adds React's development
// overhead. PROFILE=<prefix> also saves a CPU profile of each step (<prefix>-<step>.cpuprofile).
import { writeFileSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const SLOWDOWN = Number(process.argv[2] || 4);
const RUNS = Number(process.argv[3] || 3);
const COUNT = 80;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x);
const lines = [
  (i) => `message number ${i}\nwith a **second** line and a link https://example.com/${i} :smile:`,
  (i) => `short ${i} 👍`,
  (i) => `number ${i}: a longer paragraph of plain text that wraps over a few lines on a phone, so the list has messages of different heights, like a real chat does`,
  (i) => `code ${i}\n\`\`\`js\nconst x = ${i};\nconsole.log(x * 2);\n\`\`\``,
  (i) => `> quote ${i}\n- one\n- two *italic* ~~struck~~`,
];

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  const carol = await signUp(browser, 'carol');
  await makeFriends(alice, bob, carol);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= COUNT; i++) await send(alice.page, lines[i % lines.length](i));
  await openChat(carol.page, bob.id);
  await send(carol.page, 'hello from carol');

  // A guild with two busy text channels, seeded through the API.
  const api = (user, method, path, body) => user.page.evaluate(async ([m, p, b]) => {
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
    return res.json();
  }, [method, path, body]);
  const guild = await api(alice, 'POST', '/guilds', { name: 'Perf guild' });
  const general = [...(guild.channels ?? []), ...(guild.categories ?? []).flatMap((c) => c.channels ?? [])]
    .find((c) => c?.name === 'general');
  const second = await api(alice, 'POST', `/guilds/${guild.id}/channels`, { name: 'second', type: 'text' });
  const invite = await api(alice, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob, 'POST', `/invites/${invite.code}`);
  await api(carol, 'POST', `/invites/${invite.code}`);
  for (const channel of [general, second]) {
    for (let i = 1; i <= COUNT; i++) {
      await api(i % 3 ? alice : carol, 'POST', `/channels/${channel.id}/messages`, { content: lines[i % lines.length](i) });
    }
  }

  const page = bob.page;
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#dm-main');
  await page.waitForLoadState('networkidle');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (process.env.PROFILE) await cdp.send('Profiler.enable');

  const instrument = () => page.evaluate(() => {
    const perf = { frames: [], long: [], events: [] };
    window.__perf = perf;
    const loop = (t) => { perf.frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.long.push(e.duration);
    }).observe({ type: 'longtask' });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.events.push({ name: e.name, ms: e.duration, id: e.interactionId });
    }).observe({ type: 'event', durationThreshold: 16 });
  });
  const load = async () => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.goto(`${BASE}/dm`);
    await page.waitForLoadState('networkidle');
    // A phone reopens the last conversation: back to the list under it.
    const back = page.locator('.pane-back-button:visible').first();
    if (await back.count()) await back.tap();
    await page.waitForSelector(`a.dm-user[href="/dm/${alice.id}"]`, { state: 'visible' });
    await page.waitForTimeout(500);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
    await instrument();
  };
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  // Playwright's tap waits for the element to be visible and still (lists move as they load).
  const tap = (selector) => page.locator(`${selector} >> visible=true`).first().tap();
  const idle = () => page.evaluate(() => new Promise((r) => {
    // Two frames with no long task between them, then a little longer.
    let last = performance.now();
    const check = () => requestAnimationFrame((t) => (t - last < 60 ? setTimeout(r, 300) : ((last = t), check())));
    check();
  }));

  async function step(name, run, done) {
    await idle();
    await page.evaluate(() => { const p = window.__perf; p.frames = []; p.long = []; p.events = []; p.start = performance.now(); });
    const before = await metrics();
    if (process.env.PROFILE) await cdp.send('Profiler.start');
    const t0 = Date.now();
    await run();
    if (done) await done();
    const shown = Date.now() - t0;
    await idle();
    if (process.env.PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(`${process.env.PROFILE}-${name.replace(/\W+/g, '_')}.cpuprofile`, JSON.stringify(profile));
    }
    const after = await metrics();
    const p = await page.evaluate(() => window.__perf);
    const gaps = p.frames.slice(1).map((t, i) => t - p.frames[i]);
    const ms = (k) => (after[k] - before[k]) * 1000;
    return {
      shown,
      inp: Math.max(0, ...p.events.filter((e) => e.id).map((e) => e.ms)),
      slowest: p.events.filter((e) => e.id).sort((a, b) => b.ms - a.ms)[0]?.name ?? '',
      long: p.long.length, longMs: p.long.reduce((a, b) => a + b, 0),
      gap: Math.max(0, ...gaps),
      script: ms('ScriptDuration'), style: ms('RecalcStyleDuration'), layout: ms('LayoutDuration'),
    };
  }

  // A finger dragging the list `dy` px (down: scrolls up) over 30 moves, a frame apart, then
  // the scroller's position. (CDP's synthesizeScrollGesture doesn't scroll an emulated phone.)
  const scrollerTop = () => page.evaluate(() => Math.round([...document.querySelectorAll('.message-scroller')].find((el) => el.offsetParent)?.scrollTop ?? -1));
  const scroll = async (dy) => {
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 200, y }] });
    const before = await scrollerTop();
    const y0 = dy > 0 ? 250 : 650;
    await touch('touchStart', y0);
    for (let i = 1; i <= 30; i++) {
      await touch('touchMove', y0 + (dy * i) / 30);
      await new Promise((r) => setTimeout(r, 16));
    }
    await touch('touchEnd');
    await page.waitForTimeout(400);
    const after = await scrollerTop();
    if (before === after) throw new Error(`didn't scroll (scrollTop ${before})`);
  };
  const steps = [
    ['open DM from list', () => tap(`a.dm-user[href="/dm/${alice.id}"]`),
      () => page.waitForSelector('text=short 76', { state: 'visible' })],
    ['type 20 characters', () => page.click('#dm-input').then(() => page.keyboard.type('hello there friend!!', { delay: 60 }))],
    ['clear the box', () => page.keyboard.press('Control+a').then(() => page.keyboard.press('Backspace'))],
    ['scroll up', () => scroll(400)],
    ['scroll down', () => scroll(-400)],
    ['open emoji picker', () => tap('button[aria-label="Emoji"]'),
      () => page.waitForSelector('.emoji-picker-item', { state: 'visible' })],
    ['close emoji picker', () => page.keyboard.press('Escape')],
    ['long-press a message', async () => {
      const box = await page.locator('text=short 76').boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y: box.y + 5 }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }],
    ['close the menu', () => page.keyboard.press('Escape')],
    ['back to the list', () => page.goBack().then(() => page.waitForSelector(`text=${carol.name}`, { state: 'visible' }))],
    ['open guild', () => tap('.rail-guild'), () => page.waitForSelector('.guild-channel-link:has-text("general")', { state: 'visible' })],
    ['open #general', () => tap('.guild-channel-link:has-text("general")'), () => page.waitForSelector('text=message number 80', { state: 'visible' })],
    ['type in #general', () => page.click('#dm-input').then(() => page.keyboard.type('hello there friend!!', { delay: 60 }))],
    ['clear #general box', () => page.keyboard.press('Control+a').then(() => page.keyboard.press('Backspace'))],
    ['back to channels', () => page.goBack(), () => page.waitForSelector('.guild-channel-link:has-text("second")', { state: 'visible' })],
    ['open #second', () => tap('.guild-channel-link:has-text("second")'), () => page.waitForSelector('text=message number 80', { state: 'visible' })],
    ['back to channels 2', () => page.goBack(), () => page.waitForSelector('.guild-channel-link:has-text("general")', { state: 'visible' })],
    // Direct Messages, or (with an unread one) the newest unread conversation.
    ['DMs from rail', () => tap('.nav-item .nav-icon'), () => page.waitForSelector(`text=${carol.name}`, { state: 'visible' })],
  ];
  const results = Object.fromEntries(steps.map(([n]) => [n, []]));
  await load();
  for (let r = 0; r < RUNS; r++) {
    // Each run starts on the conversation list, loaded afresh (not measured).
    if (r) await load();
    for (const [name, run, done] of steps) {
      try {
        results[name].push(await step(name, run, done));
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name.replace(/\W+/g, '_')}.png` });
      } catch (err) {
        console.log(`${name}: ${err.message.split('\n').slice(0, process.env.VERBOSE ? 12 : 1).join('\n')}`);
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/fail-${name.replace(/\W+/g, '_')}.png` });
      }
    }
  }
  console.log(`Pixel 7, CPU ${SLOWDOWN}x slower, ${RUNS} runs, medians (ms):`);
  for (const [name, rs] of Object.entries(results)) {
    if (!rs.length) continue;
    const m = (k) => round(median(rs.map((x) => x[k])));
    console.log(`${name.padEnd(22)} shown ${String(m('shown')).padStart(5)} | slowest input ${String(m('inp')).padStart(4)} ${rs[0].slowest.padEnd(11)} | long tasks ${m('long')} (${m('longMs')}) | max frame gap ${String(m('gap')).padStart(4)} | script ${m('script')} style ${m('style')} layout ${m('layout')}`);
  }
} finally {
  await browser.close();
}
