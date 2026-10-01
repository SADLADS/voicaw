// How heavy a channel full of webhook embeds is (like a cinema listings bot: a description,
// fields and a big poster from another site in every message). Seeds a channel through the
// webhook API, with posters from a stand-in CDN, then measures opening the channel, hovering
// over messages and scrolling up, on a computer and on a phone with a slowed-down CPU.
//   node e2e/serve.mjs &   then   node e2e/embedperf.mjs [count] [screenshot dir]
// Numbers from the dev server include React's development overhead; for a production build,
// `vite build --config ../e2e/vite.config.mjs --outDir <tmp>` (never the default outDir: it's
// the live site) and `vite preview` with the same config, then E2E_WEB_PORT=<its port>.
import http from 'http';
import { writeFileSync } from 'fs';
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const COUNT = Number(process.argv[2] || 150);
const SHOTS = process.argv[3];
const CDN_PORT = Number(process.env.E2E_CDN_PORT || Number(process.env.E2E_API_PORT || 3099) + 5);

// Posters: 1000×1500 JPEGs with detail, so they're about as big as a real one.
const posters = await Promise.all([...Array(8)].map(async (_, i) => {
  const noise = Buffer.alloc(250 * 375 * 3);
  for (let j = 0; j < noise.length; j++) noise[j] = (Math.random() * 255 + i * 30) & 255;
  return sharp(noise, { raw: { width: 250, height: 375, channels: 3 } }).resize(1000, 1500, { kernel: 'nearest' }).jpeg({ quality: 85 }).toBuffer();
}));
const cdn = http.createServer((req, res) => {
  const n = Number(/\/poster\/(\d+)/.exec(req.url)?.[1] ?? 0);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
  res.end(posters[n % posters.length]);
}).listen(CDN_PORT);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1200, height: 850 } });
  const a = alice.page;
  const api = (path, body, method = 'POST') => a.evaluate(async ([p, b, m]) => {
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return res.json();
  }, [path, body, method]);

  const guild = await api('/guilds', { name: 'Cinema' });
  const layout = await api(`/guilds/${guild.id}`, null, 'GET');
  const general = layout.channels.find((c) => c.name === 'general');
  const listings = await api(`/guilds/${guild.id}/channels`, { name: 'cineworld-updates', type: 'text', categoryId: general.category_id });
  const hook = await api(`/channels/${listings.id}/webhooks`, { name: 'Cineworld' });

  // Post them (the webhook rate limit is 5 per 2 s: wait when told to).
  const started = Date.now();
  for (let i = 0; i < COUNT; i++) {
    const body = {
      embeds: [{
        title: `Film number ${i}: The Return of the Long Title`,
        url: `https://example.com/films/${i}`,
        color: 0xe50914,
        description: `**New showings** added for *Film ${i}*.\nRated **12A** · 2h ${i % 60}m\n\n> A gripping story about a webhook that posted ${i} times.`,
        fields: [
          { name: 'Cinema', value: 'Leicester Square', inline: true },
          { name: 'Screen', value: `IMAX ${i % 9}`, inline: true },
          { name: 'Date', value: `<t:${1790000000 + i * 3600}:F>`, inline: true },
          { name: 'Times', value: '`10:30` `13:15` `16:00` `19:45` `22:10`' },
          { name: 'Book', value: `[Tickets](https://example.com/book/${i})` },
        ],
        image: { url: `http://localhost:${CDN_PORT}/poster/${i}.jpg` },
        thumbnail: { url: `http://localhost:${CDN_PORT}/poster/${i + 3}.jpg?thumb` },
        footer: { text: 'Cineworld' },
        timestamp: new Date().toISOString(),
      }],
    };
    for (;;) {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429) {
        const wait = (await res.json()).retry_after * 1000 + 20;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status !== 204) throw new Error(`post ${i}: ${res.status} ${await res.text()}`);
      break;
    }
  }
  console.log(`seeded ${COUNT} embeds in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  async function measure(page, label, { cpu = 1 } = {}) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const busy = (m0, m1) => ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']
      .map((k) => `${k.replace('Duration', '')} ${((m1[k] - m0[k]) * 1000).toFixed(0)}ms`).join(', ');
    // Long tasks (over 50 ms) block taps and scrolling.
    await page.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
    });
    const longTasks = async () => page.evaluate(() => {
      const l = (window.__long ?? []).splice(0);
      return `${l.length} long tasks, longest ${Math.max(0, ...l).toFixed(0)}ms, total ${l.reduce((s, d) => s + d, 0).toFixed(0)}ms`;
    });

    // Open the channel from #general.
    await page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
    await page.waitForSelector('.guild-channel.active:has-text("general")', { state: 'attached' });
    await page.waitForTimeout(1000);
    await longTasks();
    let m0 = await metrics();
    if (process.env.PROFILE) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    const t0 = Date.now();
    if (label.includes('phone')) await page.goto(`${BASE}/guild/${guild.id}/${listings.id}`);
    else await page.click(`.guild-channel:has-text("cineworld-updates")`);
    await page.waitForSelector('.embed-title');
    const shown = Date.now() - t0;
    await page.waitForTimeout(4000);
    let m1 = await metrics();
    // PROFILE=<path prefix>: a CPU profile of opening it (open it in Chrome's dev tools).
    if (process.env.PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(`${process.env.PROFILE}-${label.split(',')[0]}.cpuprofile`, JSON.stringify(profile));
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/embeds-${label.split(',')[0]}.png` });
    const rows = await page.$$eval('.embed', (e) => e.length);
    console.log(`[${label}] open: first embed after ${shown}ms; ${rows} embeds rendered; ${busy(m0, m1)}; ${await longTasks()}`);

    // Hovering across messages (desktop): every hover change.
    if (!label.includes('phone')) {
      const boxes = await page.$$eval('.dm-message, .message-row, [data-key]', (els) => els.slice(-20).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) };
      }).filter((b) => b.y > 60 && b.y < innerHeight - 100));
      m0 = await metrics();
      for (let k = 0; k < 3; k++) for (const b of boxes) await page.mouse.move(b.x, b.y);
      m1 = await metrics();
      console.log(`[${label}] hover over ${boxes.length * 3} messages: ${busy(m0, m1)}; ${await longTasks()}`);
    }

    // Scrolling up through the history, a screen at a time.
    m0 = await metrics();
    for (let k = 0; k < 15; k++) {
      await page.evaluate(() => document.querySelector('.message-scroller').scrollBy(0, -innerHeight * 0.8));
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
    m1 = await metrics();
    console.log(`[${label}] scroll up 15 screens: ${busy(m0, m1)}; ${await longTasks()}; ${await page.$$eval('.embed', (e) => e.length)} embeds rendered`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }

  await measure(a, 'desktop');
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/`);
  await phone.evaluate((token) => localStorage.setItem('token', token), await a.evaluate(() => localStorage.getItem('token')));
  // Keys live in IndexedDB per context: a guild needs none, so the token is enough here.
  await measure(phone, 'phone, 4x slower CPU', { cpu: 4 });
} finally {
  await browser.close();
  cdn.close();
}
