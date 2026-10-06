// Watch Together on a phone with the keyboard up (made up as in keyboard.mjs: Android shrinks the
// page): while typing, the box stays in view (the empty page's picture, the people and the call
// buttons make way; the player stays); sending a search puts the keyboard away and the results
// show; tapping the box again keeps box and results in view. Nothing playing and a video on.
// Real YouTube (needs the internet).
//   node e2e/serve.mjs &   then   node e2e/watchkeyboard.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const KEYBOARD = 330;


// Whether each element is really seen: on screen, and what's drawn at its middle is it (not
// clipped by a scrolled box or covered by something else). Missing: null.
const seen = (page, selectors) => page.evaluate((list) => Object.fromEntries(list.map((sel) => {
  const el = document.querySelector(sel);
  if (!el) return [sel, null];
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + Math.min(r.height / 2, 10);
  const hit = r.width > 0 && r.height > 0 && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
  return [sel, Boolean(hit && (el === hit || el.contains(hit)))];
})), selectors);
const focused = (page) => page.evaluate(() => document.activeElement === document.querySelector('.watch-party-add input'));

let viewport;
const keyboardUp = async (page) => {
  await page.tap('.watch-party-add input');
  await page.setViewportSize({ width: viewport.width, height: viewport.height - KEYBOARD });
  await settle(page);
};
const keyboardDown = async (page) => {
  await page.setViewportSize(viewport);
  await settle(page);
};
async function settle(page) {
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = resolve; c.port2.postMessage(0); });
  }));
}

// Types a search with the keyboard up, then sends it: the keyboard goes, the results show; the
// box tapped again (keyboard back up) still shows them.
async function searchOnPhone(page, name, query, { playing }) {
  await keyboardUp(page);
  check(await focused(page), `${name}: the box is focused`);
  await page.fill('.watch-party-add input', '');
  await page.keyboard.type(query);
  let v = await seen(page, ['.watch-party-add input', '.watch-party-add button', '.watch-party-empty', '.watch-party-player']);
  check(v['.watch-party-add input'] && v['.watch-party-add button'], `${name}: typing, the box and its button are in view (${JSON.stringify(v)})`);
  if (!playing) check(!v['.watch-party-empty'], `${name}: the empty page's picture and words make way`);
  else check(v['.watch-party-player'], `${name}: the player stays`);
  await shot(page, `${name}-1-typing`);

  await page.keyboard.press('Enter');
  check(!(await focused(page)), `${name}: searching puts the keyboard away`);
  await keyboardDown(page);
  await page.waitForSelector('.watch-party-result', { timeout: 20000 });
  await settle(page);
  v = await seen(page, ['.watch-party-add input', '.watch-party-result', '.watch-party-empty', '.voice-view-controls']);
  check(v['.watch-party-result'] && v['.watch-party-add input'], `${name}: the box and the first result are in view (${JSON.stringify(v)})`);
  check(!v['.watch-party-empty'], `${name}: no empty-page picture over the results`);
  check(v['.voice-view-controls'], `${name}: the call buttons are back once the keyboard is down`);
  await shot(page, `${name}-2-results`);

  await keyboardUp(page);
  v = await seen(page, ['.watch-party-add input', '.watch-party-result']);
  check(v['.watch-party-add input'] && v['.watch-party-result'], `${name}: the box tapped again, the box and a result are in view above the keyboard (${JSON.stringify(v)})`);
  await shot(page, `${name}-3-refine`);
  await page.evaluate(() => document.activeElement?.blur());
  await keyboardDown(page);
}

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const c = carol.page;
  c.on('console', (m) => {
    if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200));
  });
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Phone Watch');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Cinema');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const cinema = a.url().replace(/^https?:\/\/[^/]+/, BASE);
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.click('button:has-text("Accept invite")');
  await c.waitForSelector('#dm-input');
  await c.goto(cinema);
  await c.waitForSelector('.voice-view-join', { timeout: 15000 });
  await c.click('.voice-view-join');
  await c.waitForSelector('.watch-party-toggle', { timeout: 20000 });
  await c.click('.watch-party-toggle');
  await c.waitForSelector('.watch-party-add input');
  await shot(c, '0-empty');

  viewport = c.viewportSize();
  await searchOnPhone(c, 'empty', 'me at the zoo', { playing: false });

  await c.click('.watch-party-result button');
  await c.waitForSelector('.watch-party-player.docked iframe', { timeout: 15000 });
  await c.click('button[aria-label="Close the search results"]');
  await settle(c);
  await searchOnPhone(c, 'playing', 'rick astley', { playing: true });
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all good');
process.exit(failures ? 1 : 0);
