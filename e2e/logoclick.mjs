// The rail's logo goes nowhere for now: clicking it doesn't navigate (the page on screen stays),
// it only pops (grows a little and back, quickly), again on every click. Desktop and phone.
//   node e2e/serve.mjs &   then   node e2e/logoclick.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Records navigations and the logo's scale every frame from now on.
const watch = (page) => page.evaluate(() => {
  window.__navs = [];
  window.__scales = [];
  if (!window.__navWatch) {
    window.__navWatch = true;
    navigation.addEventListener('navigate', (e) => window.__navs.push(new URL(e.destination.url).pathname));
  }
  const logo = document.querySelector('.rail-logo');
  const started = performance.now();
  const frame = () => {
    const m = new DOMMatrix(getComputedStyle(logo).transform);
    window.__scales.push([performance.now() - started, m.a]);
    if (performance.now() - started < 1500) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});

async function checkLogo(page, label) {
  await page.waitForSelector('.rail-logo');
  const before = await page.evaluate(() => location.pathname + location.search);
  check(await page.evaluate(() => !document.querySelector('.rail-logo').closest('a')), `${label}: logo isn't a link`);
  await watch(page);
  const logo = page.locator('.rail-logo');
  await logo.click();
  await page.waitForTimeout(60);
  await shot(page, `${label}-pop`);
  await page.waitForTimeout(400);
  await logo.click();
  await page.waitForTimeout(1200);
  const { navs, scales } = await page.evaluate(() => ({ navs: window.__navs, scales: window.__scales }));
  const after = await page.evaluate(() => location.pathname + location.search);
  check(navs.length === 0 && after === before, `${label}: no navigation (${before} -> ${after}, ${JSON.stringify(navs)})`);
  // Each pop: a run of frames above 1, peaking near 1.12, lasting well under half a second.
  const pops = [];
  for (const [t, s] of scales) {
    if (s > 1.001) {
      const last = pops[pops.length - 1];
      if (last && t - last.end < 50) { last.end = t; last.peak = Math.max(last.peak, s); } else pops.push({ start: t, end: t, peak: s });
    }
  }
  check(pops.length === 2, `${label}: popped on each of two clicks (${pops.length})`);
  check(pops.every((p) => p.peak > 1.08 && p.peak <= 1.121 && p.end - p.start < 250),
    `${label}: small and quick (${pops.map((p) => `peak ${p.peak.toFixed(3)} for ${Math.round(p.end - p.start)} ms`).join(', ')})`);
  check(scales[scales.length - 1][1] === 1, `${label}: back to normal size`);
  await shot(page, `${label}-after`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await makeFriends(alice, bob);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello');
  await alice.page.waitForSelector('text=hello');
  await checkLogo(alice.page, 'desktop');
  // The rail is on the list pane: open the chat, then Back to the list.
  await bob.page.goto(`${BASE}/dm/${alice.id}`);
  await bob.page.waitForSelector('#dm-input');
  await bob.page.waitForTimeout(500);
  await bob.page.evaluate(() => history.back());
  await bob.page.waitForFunction(() => document.querySelector('.main-wrapper.pane-list:not(.panes-moving)'));
  await bob.page.waitForTimeout(200);
  await checkLogo(bob.page, 'phone');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
