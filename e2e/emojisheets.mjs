// The emoji picker's sprite sheets (client/src/emoji/emojiSheets.js): standard emoji are drawn
// from one image per category, so a whole category shows at once instead of filling in one
// SVG at a time. Checks: no per-emoji SVGs fetched, at most the 8 category sheets, every
// visible cell's sheet loaded (and how long that took, cold and with the service worker's
// copy), the skin tone sheets, the worker fetching the sheets before the picker is first
// opened, and the docked picker on a phone.
//   node e2e/serve.mjs &   then   node e2e/emojisheets.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Opens the picker; resolves to { ms, sheets, svgs }: how long until every cell in view had
// its sheet loaded, which sheets were fetched and how many emoji SVGs.
async function openPicker(page, docked = false) {
  await page.evaluate(() => performance.clearResourceTimings());
  const started = Date.now();
  await page.click('button[aria-label="Emoji"]');
  await page.waitForSelector(`.emoji-picker${docked ? '.docked' : ''} .emoji-sprite`);
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.emoji-picker-scroll').getBoundingClientRect();
    const loaded = new Set(performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/emoji/sheets/') && e.responseEnd > 0)
      .map((e) => new URL(e.name).pathname.split('/').pop().replace('.webp', '')));
    const visible = [...document.querySelectorAll('.emoji-picker-scroll .emoji-sprite')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > scroller.top && r.top < scroller.bottom;
    });
    return visible.length > 0 && visible.every((el) => loaded.has([...el.classList].find((c) => c.startsWith('emoji-sheet-')).slice(12)));
  }, null, { timeout: 30000 });
  const ms = Date.now() - started;
  const { sheets, svgs } = await page.evaluate(() => {
    const names = performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname);
    return {
      sheets: names.filter((n) => n.includes('/emoji/sheets/')).map((n) => n.split('/').pop()),
      svgs: names.filter((n) => /\/emoji\/[0-9a-f-]+\.svg$/.test(n)).length,
    };
  });
  return { ms, sheets, svgs };
}

const browser = await launchChrome();
try {
  // Cold: no service worker, so nothing cached ahead.
  const cold = await signUp(browser, 'cold', { viewport: { width: 1100, height: 750 }, serviceWorkers: 'block' });
  const other = await signUp(browser, 'other');
  await openChat(cold.page, other.id);
  const first = await openPicker(cold.page);
  console.log(`cold picker: every visible emoji drawn in ${first.ms} ms; sheets ${first.sheets.join(', ')}; ${first.svgs} emoji SVGs`);
  if (first.svgs > 0) throw new Error('the picker fetched emoji SVGs');
  if (first.sheets.length > 8 || first.sheets.some((s) => s.startsWith('tone'))) throw new Error(`unexpected sheets: ${first.sheets}`);
  await shot(cold.page, 'picker-cold');

  // Hovering shows the preview from the same sheet.
  await cold.page.hover('.emoji-picker-item[aria-label="Pizza"]');
  const preview = await cold.page.$eval('.emoji-picker-preview .emoji', (el) => [...el.classList].join(' '));
  if (!preview.includes('emoji-sheet-foods')) throw new Error(`preview not from its sheet: ${preview}`);

  // A skin tone: emoji that have tones come from that tone's sheet.
  await cold.page.click('.emoji-picker-tone-toggle');
  await cold.page.click('[aria-label="Skin tone 3"]');
  const thumbs = await cold.page.$eval('.emoji-picker-item[aria-label="Thumbs Up"] .emoji', (el) => [...el.classList].join(' '));
  if (!thumbs.includes('emoji-sheet-tone3')) throw new Error(`thumbs up not on the tone sheet: ${thumbs}`);
  await cold.page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => e.name.endsWith('/tone3.webp') && e.responseEnd > 0));
  await cold.page.waitForTimeout(300);
  await shot(cold.page, 'picker-tone3');

  // With the service worker: it has the sheets before the picker is ever opened.
  const warm = other.page;
  await warm.waitForFunction(async () => {
    const names = await caches.keys();
    const cache = names.find((n) => n.startsWith('emoji-'));
    if (!cache) return false;
    const keys = await (await caches.open(cache)).keys();
    return keys.filter((r) => r.url.includes('/emoji/sheets/')).length >= 8;
  }, null, { timeout: 60000, polling: 500 });
  await openChat(warm, cold.id);
  const second = await openPicker(warm);
  console.log(`picker with the worker's copy: drawn in ${second.ms} ms`);
  if (second.svgs > 0) throw new Error('the picker fetched emoji SVGs');

  // The docked picker on a phone.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  await openChat(phone.page, other.id);
  const docked = await openPicker(phone.page, true);
  console.log(`phone docked picker: drawn in ${docked.ms} ms`);
  await shot(phone.page, 'picker-phone');

  console.log('emoji sheets e2e: ok');
} catch (err) {
  console.error('emoji sheets e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
