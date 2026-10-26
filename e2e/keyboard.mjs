// Phone keyboard (utils/keyboardViewport.js, interactive-widget in index.html): the message box
// stays above the on-screen keyboard. Headless Chrome has no keyboard, so it's made up:
// Android Chrome (resizes-content) shrinks the page, done here by shrinking the window; iOS
// lays the keyboard over the page and slides it, done here with a stand-in visualViewport.
//   node e2e/serve.mjs &   then   node e2e/keyboard.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const KEYBOARD = 330;

// After layout and paint (see e2e/README.md tips).
const settled = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = resolve; c.port2.postMessage(0); });
}));

// Where the message box and the newest message are, against the visible bottom.
const layout = (page, visibleBottom) => page.evaluate((bottom) => {
  const box = document.querySelector('#dm-input').getBoundingClientRect();
  // Send, or the mic in its place while the box is empty (phones).
  const send = document.querySelector('.send-button, .voice-mic-button').getBoundingClientRect();
  const rows = [...document.querySelectorAll('.each-dm-message-wrapper')];
  const last = rows.at(-1)?.getBoundingClientRect();
  return {
    boxBottom: Math.round(Math.max(box.bottom, send.bottom)),
    lastBottom: Math.round(last?.bottom ?? 0),
    boxTop: Math.round(box.top),
    visibleBottom: bottom ?? window.innerHeight,
    appHeight: document.documentElement.style.getPropertyValue('--vc-app-height'),
    scrollY: window.scrollY,
    focused: document.activeElement?.id === 'dm-input',
  };
}, visibleBottom);

// A one-finger drag through CDP touch events (as in panes.mjs).
async function drag(page, { x, y, dx, steps = 10, ms = 16 }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
  });
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', x + (dx * i) / steps, y);
    await new Promise((r) => setTimeout(r, ms));
  }
  await touch('touchEnd');
  await cdp.detach();
}

async function swipeToReply(page, text) {
  const box = await page.locator('.each-dm-message-wrapper', { hasText: text }).last().boundingBox();
  await drag(page, { x: box.x + box.width * 0.6, y: box.y + box.height / 2, dx: -140, steps: 14, ms: 20 });
  await page.waitForSelector('.reply-bar');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 1; i <= 25; i++) await send(alice.page, `message number ${i}\nsecond line`);

  const page = bob.page;
  const viewport = page.viewportSize();
  check(await page.evaluate(() => document.querySelector('meta[name=viewport]').content.includes('interactive-widget=resizes-content')),
    'the viewport asks Android to resize the page for the keyboard');

  // Android Chrome: swipe to reply, the keyboard comes up and the page shrinks for it.
  await openChat(page, alice.id);
  await page.waitForSelector('text=message number 25');
  await page.waitForTimeout(500);
  await swipeToReply(page, 'message number 24');
  await page.setViewportSize({ width: viewport.width, height: viewport.height - KEYBOARD });
  await page.waitForTimeout(300);
  await settled(page);
  let l = await layout(page);
  check(l.focused, 'Android: the message box is focused after the swipe');
  check(l.boxBottom <= l.visibleBottom && l.boxTop > 0, `Android: it's above the keyboard (bottom ${l.boxBottom} of ${l.visibleBottom})`);
  check(l.lastBottom <= l.boxTop + 1, 'Android: the newest message is still in view above it');
  await shot(page, '1-android-keyboard');
  // Dragging on the header can't take it anywhere: the page doesn't scroll.
  await page.mouse.wheel(0, -400);
  await page.evaluate(() => window.scrollBy(0, 300));
  await settled(page);
  l = await layout(page);
  check(l.scrollY === 0 && l.boxBottom <= l.visibleBottom, 'Android: the page itself never scrolls the box away');
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  l = await layout(page);
  check(l.boxBottom <= viewport.height && l.boxBottom > viewport.height - 120, 'Android: back at the bottom when the keyboard closes');

  // Tapping Send leaves the box focused, so the keyboard stays up for the next message; with
  // the keyboard down, it doesn't bring it up.
  await page.locator('#dm-input').tap();
  await page.keyboard.type('first of two');
  await page.locator('.send-button').tap();
  await page.waitForSelector('.each-dm-message-wrapper:has-text("first of two")');
  check((await layout(page)).focused, 'Send keeps the message box focused (keyboard stays up)');
  await page.keyboard.type('second of two');
  await page.locator('.send-button').tap();
  await page.waitForSelector('.each-dm-message-wrapper:has-text("second of two")');
  check(await alice.page.locator('text=second of two').waitFor().then(() => true, () => false), 'the next message is typed and sent straight away');
  // (Something typed: an empty box shows the mic in Send's place.)
  await page.keyboard.type('third, sent unfocused');
  await page.evaluate(() => document.activeElement.blur());
  await page.locator('.send-button').tap();
  await page.waitForSelector('.each-dm-message-wrapper:has-text("third, sent unfocused")');
  check(!(await layout(page)).focused, "Send with the box unfocused doesn't focus it (keyboard stays down)");

  // iOS: the keyboard lies over the page and the page slides up; a stand-in visualViewport.
  await page.addInitScript(() => {
    const state = { height: window.innerHeight, offsetTop: 0 };
    const listeners = new Set();
    const fake = {
      get width() { return window.innerWidth; },
      get height() { return state.height; },
      get offsetTop() { return state.offsetTop; },
      scale: 1,
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    const scrollTo = window.scrollTo.bind(window);
    window.__scrolledBack = 0;
    // iOS 26 Safari (`__stuck`): scrolling back leaves the visible part pushed down.
    // `__repush`: scrolling back works for a moment, then iOS pushes the visible part down again
    // to keep the caret in view (a frame later), as it does while typing.
    window.scrollTo = (...args) => {
      window.__scrolledBack++;
      const pushed = state.offsetTop;
      if (!window.__stuck) state.offsetTop = 0;
      scrollTo(...args);
      if (window.__repush && pushed > 0) {
        listeners.forEach((fn) => fn());
        requestAnimationFrame(() => { state.offsetTop = pushed; listeners.forEach((fn) => fn()); });
      }
    };
    // iOS sliding the page as the keyboard comes up: no event, the full height kept till the end.
    window.__slide = (offsetTop) => { state.offsetTop = offsetTop; };
    // The keyboard opening (height) with the page slid up by `offsetTop`.
    window.__keyboard = (height, offsetTop = 0) => {
      state.height = height;
      state.offsetTop = offsetTop;
      listeners.forEach((fn) => fn());
    };
  });
  await page.reload();
  await page.waitForSelector('text=message number 25');
  await page.waitForTimeout(500);
  await swipeToReply(page, 'message number 23');
  const visible = viewport.height - KEYBOARD;
  await page.evaluate(([h, k]) => window.__keyboard(h, k), [visible, KEYBOARD]); // iOS slides the page to the box
  await page.waitForTimeout(200);
  await settled(page);
  // The visible part is the page's KEYBOARD..bottom: the app follows the slide there, never
  // scrolling it back (which set iOS sliding again, the screen shaking while typing).
  const appTop = () => page.evaluate(() => Math.round(document.querySelector('.slidey .main-content-wrapper').getBoundingClientRect().top));
  l = await layout(page, viewport.height);
  check(l.appHeight === `${visible}px`, `iOS: the app is sized to the part above the keyboard (${l.appHeight})`);
  check(await appTop() >= KEYBOARD - 1, `iOS: the app follows the slide to the visible part (${await appTop()}, visible from ${KEYBOARD})`);
  check(l.boxBottom <= viewport.height && l.boxBottom >= viewport.height - 80,
    `iOS: the box sits on the keyboard (bottom ${l.boxBottom}, keyboard at ${viewport.height})`);
  check(await page.evaluate(() => window.__scrolledBack === 0), 'iOS: the page is never scrolled back');
  check(l.lastBottom <= l.boxTop + 1 && l.lastBottom > KEYBOARD, 'iOS: the newest message is in view above it');
  await shot(page, '2-ios-keyboard');
  // The user drags the page part of the way back: the app follows it there too.
  await page.evaluate(([h]) => window.__keyboard(h, 120), [visible]);
  await settled(page);
  check(Math.abs(await appTop() - 120) <= 1 && await page.evaluate(() => window.__scrolledBack === 0), 'iOS: and follows the page dragged');
  await page.evaluate(([h]) => window.__keyboard(h, 0), [viewport.height]);
  await settled(page);
  check((await layout(page)).appHeight === '', 'iOS: full height again once the keyboard closes');

  // The keyboard coming up: the page slides with its animation before the visible height drops.
  // The app follows it every frame, the box staying on the keyboard (it went up off the top,
  // then jumped back down once the keyboard was up).
  await page.evaluate(() => document.activeElement?.blur());
  await settled(page);
  const during = await page.evaluate(async ([k]) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    document.querySelector('#dm-input').focus();
    let header = 0;
    let box = Infinity;
    for (let i = 1; i <= 12; i++) {
      const off = Math.round((k * i) / 12);
      window.__slide(off);
      await frame();
      await frame();
      const top = document.querySelector('.slidey .main-content-wrapper').getBoundingClientRect().top;
      header = Math.max(header, Math.abs(top - off));
      box = Math.min(box, document.querySelector('.send-button, .voice-mic-button').getBoundingClientRect().bottom);
    }
    return { header: Math.round(header), box: Math.round(box) };
  }, [KEYBOARD]);
  check(during.header <= 1, `iOS: as the keyboard comes up, the app's top follows the slide (${during.header}px off at worst)`);
  check(during.box >= viewport.height - 80, `iOS: and the box stays at the bottom (${during.box} of ${viewport.height})`);
  await page.evaluate(([h, k]) => window.__keyboard(h, k), [visible, KEYBOARD]);
  await settled(page);
  l = await layout(page, viewport.height);
  check(l.appHeight === `${visible}px` && await appTop() >= KEYBOARD - 1 && l.boxBottom >= viewport.height - 80,
    `iOS: then sized to the part above the keyboard, no jump (${l.appHeight}, top ${await appTop()})`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(([h]) => window.__keyboard(h, 0), [viewport.height]);
  await settled(page);
  check((await layout(page)).appHeight === '' && await appTop() === 0, 'iOS: back in place once it closes');

  // iOS 26, where scrolling back wouldn't work anyway: the same (no gap between the box and the
  // keyboard, nothing above it cut off).
  await page.evaluate(() => { window.__stuck = true; });
  await page.locator('#dm-input').focus();
  await page.evaluate(([h, k]) => window.__keyboard(h, k), [visible, KEYBOARD]);
  await settled(page);
  l = await layout(page, viewport.height);
  const header = await page.evaluate(() => Math.round(document.querySelector('.slidey .main-content-wrapper').getBoundingClientRect().top));
  check(l.appHeight === `${visible}px` && header >= KEYBOARD - 1,
    `iOS 26: the app starts where the visible part does (${header}, visible from ${KEYBOARD})`);
  check(l.boxBottom <= viewport.height && l.boxBottom >= viewport.height - 80,
    `iOS 26: the box sits on the keyboard, no gap (bottom ${l.boxBottom}, keyboard at ${viewport.height})`);
  check(l.lastBottom <= l.boxTop + 1 && l.lastBottom > KEYBOARD, 'iOS 26: the newest message is in view above it');
  await shot(page, '3-ios26-keyboard');
  await page.evaluate(([h]) => window.__keyboard(h, 0), [viewport.height]);
  await settled(page);
  l = await layout(page);
  check(l.appHeight === '' && await page.evaluate(() => getComputedStyle(document.getElementById('root')).paddingTop) === '0px',
    'iOS 26: back in place once the keyboard closes');

  // iOS pushing the visible part back down after each scroll back (to keep the caret in view):
  // typing must not set off a tug of war, the app jumping up and down (reported 2026-10-22).
  await page.evaluate(() => { window.__stuck = false; window.__repush = true; });
  await page.locator('#dm-input').focus();
  await page.evaluate(([h, k]) => window.__keyboard(h, k), [visible, KEYBOARD]);
  await settled(page);
  const moves = await page.evaluate(async () => {
    const root = document.getElementById('root');
    let last = getComputedStyle(root).paddingTop;
    let changes = 0;
    const watch = () => {
      const now = getComputedStyle(root).paddingTop;
      if (now !== last) changes++;
      last = now;
      if (performance.now() < end) requestAnimationFrame(watch);
    };
    const end = performance.now() + 1000;
    const scrolledBefore = window.__scrolledBack;
    requestAnimationFrame(watch);
    await new Promise((r) => setTimeout(r, 1100));
    return { changes, scrolledBack: window.__scrolledBack - scrolledBefore };
  });
  await page.keyboard.type('typing along', { delay: 30 });
  check(moves.changes <= 1 && moves.scrolledBack <= 1,
    `iOS: typing doesn't make the app jump up and down (${moves.changes} moves, ${moves.scrolledBack} scrolls back in a second)`);
  l = await layout(page, viewport.height);
  check(l.boxBottom <= viewport.height && l.boxBottom >= viewport.height - 80, `iOS: the box still sits on the keyboard (bottom ${l.boxBottom})`);
  await page.evaluate(([h]) => window.__keyboard(h, 0), [viewport.height]);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
