// Touch scrolling the sidebar lists: a finger starting a scroll on a channel (or DM, member) row
// doesn't leave it in its hover colour; with a mouse, hovering still colours it.
//   node e2e/serve.mjs &   then   node e2e/touchhover.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const background = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
const colourOf = (page, token) => page.evaluate((t) => {
  const probe = document.createElement('div');
  probe.style.backgroundColor = `var(${t})`;
  document.body.appendChild(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
}, token);
const scrollerOf = (locator) => locator.evaluate((el) => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p.scrollTop;
  }
  return null;
});

// A finger dragging up from (x, y): a scroll, as a phone sends it.
async function touchScroll(page, x, y, distance, end = true) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: py }],
  });
  await touch('touchStart', y);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', y - (distance * i) / 10);
    await pause(16);
  }
  if (end) await touch('touchEnd');
  return cdp;
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });

  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Many' });
  for (let i = 1; i <= 30; i++) {
    await api(alice.page, 'POST', `/guilds/${guild.id}/channels`, { name: `channel-${i}` });
  }
  const invite = await api(alice.page, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);

  // Bob, on a phone, scrolls the channel list.
  const b = bob.page;
  const swipeRight = async () => {
    const swipe = await b.context().newCDPSession(b);
    const width = b.viewportSize().width;
    const touch = (type, x) => swipe.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }] });
    await touch('touchStart', 40);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', 40 + (width * 0.7 * i) / 10);
      await pause(16);
    }
    await touch('touchEnd');
    await pause(800);
  };
  check(!(await b.evaluate(() => matchMedia('(hover: hover)').matches)), 'the phone has no hover');
  await b.goto(`${BASE}/guild/${guild.id}`);
  await b.waitForSelector('#dm-input');
  // The guild opens on its first channel: swipe right to the channel list.
  await swipeRight();
  await b.waitForSelector('.guild-channel >> text=channel-10');
  const hover = await colourOf(b, '--vc-bg-hover');
  const row = b.locator('.guild-channel', { has: b.locator('.guild-channel-name', { hasText: /^channel-5$/ }) });
  const box = await row.boundingBox();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  // A real phone's Chrome puts its pointer where a finger rests before it moves (tap down), so the row
  // under it is :hover and stays so. Headless Chrome's touches never do: move the pointer there as a
  // phone would, then scroll from that spot.
  const cdp = await b.context().newCDPSession(b);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  check(await row.evaluate((el) => el.matches(':hover')), 'the row under the finger is :hover, as on a phone');
  check(await background(row) !== hover, 'but not in the hover colour');
  const textColour = (r) => r.locator('.guild-channel-name').evaluate((el) => getComputedStyle(el).color);
  const other = b.locator('.guild-channel', { has: b.locator('.guild-channel-name', { hasText: /^channel-6$/ }) });
  check(await textColour(row) === await textColour(other), 'nor in another text colour (no link colour)');
  const before = await scrollerOf(row);
  await touchScroll(b, x, y, 200);
  await pause(300);
  check(await scrollerOf(row) > before, `the finger scrolled the list (${before} → ${await scrollerOf(row)})`);
  const coloured = await b.$$eval('.guild-channel:not(.active), .guild-thread:not(.active)', (els, c) => els
    .filter((el) => getComputedStyle(el).backgroundColor === c).map((el) => el.textContent), hover);
  await shot(b, 'phone-after-scroll');
  check(coloured.length === 0, `no channel in the hover colour after scrolling (${coloured.join(', ') || 'none'})`);

  // The DM list the same way (the list is a swipe right of the chat).
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('#dm-main');
  await swipeRight();
  const dmRow = b.locator('.dm-user:not(.active)').first();
  if (await dmRow.count()) {
    // Background and every text colour in the row, to compare with the pointer away and on it.
    const looks = () => dmRow.evaluate((el) => [el, ...el.querySelectorAll('*')]
      .map((e) => `${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).color}`).join('|'));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    const away = await looks();
    const dmBox = await dmRow.boundingBox();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dmBox.x + 20, y: dmBox.y + dmBox.height / 2 });
    check(await dmRow.evaluate((el) => el.matches(':hover')), 'a DM row under the finger is :hover');
    const on = await looks();
    if (on !== away) console.log(away.split('|').map((v, i) => v === on.split('|')[i] ? null : `  #${i}: ${v} → ${on.split('|')[i]}`).filter(Boolean).join('\n'), await dmRow.evaluate((el) => el.outerHTML.slice(0, 600)));
    check(on === away, 'but looks just as it did (background and text)');
  } else {
    console.log('  (no inactive DM row to check)');
  }

  // Alice, with a mouse: hovering a channel still colours it.
  const a = alice.page;
  await a.goto(`${BASE}/guild/${guild.id}`);
  const aliceRow = a.locator('.guild-channel', { has: a.locator('.guild-channel-name', { hasText: /^channel-3$/ }) });
  await aliceRow.hover();
  await pause(100);
  check(await background(aliceRow) === hover, 'a mouse hover still colours the channel');
  await a.mouse.move(900, 600);
  await pause(100);
  check(await background(aliceRow) !== hover, 'and moving away clears it');
  await shot(a, 'desktop-hover');
  console.log('touchhover: all checks passed');
} finally {
  await browser.close();
}
