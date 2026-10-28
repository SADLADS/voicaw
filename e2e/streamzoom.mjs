// Zooming into a watched stream in real browsers, through the e2e LiveKit: Alice shares her
// screen (Chrome's fake one), Bob watches. The wheel zooms on the point under the pointer (that
// point stays put) without scrolling the page, a drag looks around but never past the picture's
// edge, the bar's zoom in / out buttons and slider (shown on hover, 100%–800%), the percentage
// fits it again, a new stream starts fitted; the popped-out window zooms too, the corner
// doesn't. Carol, on a phone, pinches with two fingers, has the buttons but no slider, and the
// bar fits.
//   node e2e/serve.mjs &   then   node e2e/streamzoom.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log('ok:', what);
}

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

const setSlider = (page, sel, value) => page.$eval(sel, (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

// Where the video's picture is drawn (the element's box after the transform, shrunk to the
// picture's aspect, as object-fit: contain does), and the stage's box.
const geometry = (page) => page.evaluate(() => {
  const stage = document.querySelector('.stream-view').getBoundingClientRect();
  const video = document.querySelector('.stream-view video');
  const box = video.getBoundingClientRect();
  const k = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * k;
  const height = video.videoHeight * k;
  return {
    stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
    picture: { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height },
    percent: document.querySelector('.stream-zoom-reset')?.textContent ?? null,
    scrollY: document.scrollingElement?.scrollTop ?? 0,
  };
});

// Where a screen point falls in the picture, as fractions of it.
const pictureFraction = (g, x, y) => ({ fx: (x - g.picture.left) / g.picture.width, fy: (y - g.picture.top) / g.picture.height });
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
// Waits out the buttons' 0.15 s animation.
const settle = (page) => page.waitForTimeout(300);

const tile = (name) => `.voice-tile:has-text("${name}")`;
const zoomIn = '.stream-view button[aria-label="Zoom in"]';
const zoomOut = '.stream-view button[aria-label="Zoom out"]';
const zoomSlider = '.stream-view .stream-zoom-slider';
const reset = '.stream-view .stream-zoom-reset';

const browser = await launchChrome({ args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated/.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Stream Zoom');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  const guildId = /\/guild\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const channelId = /\/guild\/\d+\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await videoPlaying(a);
  check(Boolean(await a.$(zoomIn)), 'her own stream can be zoomed too');

  await b.waitForSelector(`${tile(alice.name)} .voice-tile-watch`, { timeout: 10000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  await b.waitForTimeout(500); // the stage settles under the tiles
  const fitted = await geometry(b);
  check(fitted.percent === null && await b.$eval(zoomOut, (el) => el.disabled), 'it starts fitted, zoom out greyed');

  // The wheel on a point a third of the way across and down: that point stays under the pointer.
  const px = fitted.picture.left + fitted.picture.width / 3;
  const py = fitted.picture.top + fitted.picture.height / 3;
  const before = pictureFraction(fitted, px, py);
  await b.mouse.move(px, py);
  for (let i = 0; i < 3; i++) await b.mouse.wheel(0, -200);
  await b.waitForFunction(() => document.querySelector('.stream-zoom-reset'));
  await b.waitForTimeout(200);
  const wheeled = await geometry(b);
  const after = pictureFraction(wheeled, px, py);
  console.log('wheel:', wheeled.percent, JSON.stringify({ before, after }));
  await shot(b, '01-bob-wheel-zoomed');
  check(wheeled.picture.width > fitted.picture.width * 2, 'scrolling up zooms in');
  check(close(before.fx, after.fx) && close(before.fy, after.fy), 'the point under the pointer stays put');
  check(wheeled.scrollY === fitted.scrollY, "the page doesn't scroll");
  check(await b.$eval('.stream-view', (el) => getComputedStyle(el).cursor) === 'grab', 'zoomed, the stage shows a grab cursor');

  // Dragging far right and down shows the picture's top left corner, no further.
  await b.mouse.move(px, py);
  await b.mouse.down();
  await b.mouse.move(px + 2000, py + 2000, { steps: 10 });
  await b.mouse.up();
  const dragged = await geometry(b);
  console.log('dragged:', JSON.stringify(dragged.picture), JSON.stringify(dragged.stage));
  check(close(dragged.picture.left, dragged.stage.left, 1.5) && close(dragged.picture.top, dragged.stage.top, 1.5), 'dragging stops at the top left corner');
  await b.mouse.move(px, py);
  await b.mouse.down();
  await b.mouse.move(px - 4000, py - 4000, { steps: 10 });
  await b.mouse.up();
  const draggedBack = await geometry(b);
  const right = draggedBack.picture.left + draggedBack.picture.width;
  const bottom = draggedBack.picture.top + draggedBack.picture.height;
  check(close(right, draggedBack.stage.left + draggedBack.stage.width, 1.5)
    && close(bottom, draggedBack.stage.top + draggedBack.stage.height, 1.5), 'and the other way at the bottom right one');
  check(await b.$('.stream-view:fullscreen') === null, 'dragging doesn\'t go full screen');

  // The percentage fits it again; then the buttons.
  await b.click(reset);
  await settle(b);
  const back = await geometry(b);
  check(close(back.picture.width, fitted.picture.width, 1) && back.percent === null, 'the percentage fits it again');
  await b.click(zoomIn);
  await settle(b);
  check((await geometry(b)).percent === '150%', 'zoom in: 150%');
  await b.click(zoomIn);
  await settle(b);
  check((await geometry(b)).percent === '225%', 'and again: 225%');
  await b.click(zoomOut);
  await settle(b);
  check((await geometry(b)).percent === '150%', 'zoom out: 150%');

  // The slider shows on hover; 800% at the end, where zoom in greys out.
  await b.evaluate(() => document.activeElement?.blur());
  await b.mouse.move(5, 5);
  await b.waitForTimeout(300);
  const hiddenWidth = await b.$eval(zoomSlider, (el) => el.getBoundingClientRect().width);
  await b.hover('.stream-view .stream-zoom');
  await b.waitForFunction((sel) => document.querySelector(sel).getBoundingClientRect().width > 60, zoomSlider);
  check(hiddenWidth < 1, 'the slider shows on hover');
  await setSlider(b, zoomSlider, 300);
  check((await geometry(b)).percent === '800%' && await b.$eval(zoomIn, (el) => el.disabled), 'the slider goes to 800%, zoom in greyed');
  await setSlider(b, zoomSlider, 100);
  check((await geometry(b)).percent === '200%', 'halfway along it: 200%');
  const bar = await b.evaluate(() => {
    const bar = document.querySelector('.stream-bar').getBoundingClientRect();
    return [...document.querySelectorAll('.stream-bar > *')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5;
    });
  });
  check(bar, 'the bar fits with the zoom controls');
  await shot(b, '02-bob-zoom-slider');

  // The wheel over the bar doesn't zoom.
  const overBar = await b.$eval('.stream-name', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await b.mouse.move(overBar.x, overBar.y);
  await b.mouse.wheel(0, -300);
  await b.waitForTimeout(200);
  check((await geometry(b)).percent === '200%', "the wheel over the bar doesn't zoom");

  // Popped out: zooms in its own window, starting fitted.
  const [popup] = await Promise.all([
    b.waitForEvent('popup'),
    b.click('.stream-view button[aria-label="Pop out"]'),
  ]);
  await popup.waitForSelector('.stream-view.popped-out');
  await videoPlaying(popup);
  await popup.waitForTimeout(300);
  const popFitted = await geometry(popup);
  await popup.mouse.move(popFitted.stage.width / 2, popFitted.stage.height / 2);
  await popup.mouse.wheel(0, -400);
  await popup.waitForFunction(() => document.querySelector('.stream-zoom-reset'));
  const popZoomed = await geometry(popup);
  console.log('pop-out:', popZoomed.percent);
  check(popFitted.percent === null && popZoomed.picture.width > popFitted.picture.width * 1.5, 'the popped-out window zooms with the wheel');
  await shot(popup, '03-popout-zoomed');
  await popup.click('.stream-view button[aria-label="Bring back"]');
  await b.waitForSelector('.stream-view:not(.popped-out)');

  // In the corner (another page): no zoom.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector('.stream-view.corner');
  await videoPlaying(b);
  check(!(await b.$('.stream-view.corner .stream-zoom')), 'the corner has no zoom controls');
  await b.hover('.stream-view.corner');
  await b.mouse.wheel(0, -400);
  await b.waitForTimeout(200);
  check(await b.$eval('.stream-view.corner video', (el) => el.style.transform) === '', "the wheel doesn't zoom it");

  // Carol on a phone: two fingers pinch (Chrome's touch events through the DevTools protocol).
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.waitForSelector('.voice-view-join');
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  await c.waitForTimeout(500);
  const phoneFitted = await geometry(c);
  check(!(await c.$(zoomSlider)) && !(await c.$(zoomIn)) && !(await c.$(reset)), 'a phone has no zoom buttons or slider (no room: fingers pinch)');
  const cdp = await c.context().newCDPSession(c);
  const cx = phoneFitted.picture.left + phoneFitted.picture.width / 2;
  const cy = phoneFitted.picture.top + phoneFitted.picture.height / 2;
  const touch = (type, spread) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }],
  });
  await touch('touchStart', 20);
  for (let spread = 25; spread <= 60; spread += 5) await touch('touchMove', spread);
  await touch('touchEnd', 60);
  await c.waitForTimeout(200);
  const pinched = await geometry(c);
  console.log('pinch:', pinched.percent);
  check(pinched.picture.width > phoneFitted.picture.width * 2.5, 'pinching zooms in (fingers three times as far apart)');
  check(pinched.scrollY === phoneFitted.scrollY, "the page doesn't scroll or zoom");
  const phone = await c.evaluate(() => {
    const bar = document.querySelector('.stream-bar').getBoundingClientRect();
    const fits = [...document.querySelectorAll('.stream-bar > *')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5;
    });
    const items = [...document.querySelectorAll('.stream-bar > *')].map((el) => [el.className, Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().right)]);
    return { fits, items, bar: [bar.left, bar.right], overflow: document.documentElement.scrollWidth > innerWidth };
  });
  if (!phone.fits || phone.overflow) await shot(c, '04-carol-bar-overflow');
  console.log('phone bar:', JSON.stringify(phone));
  check(phone.fits && !phone.overflow, 'on a phone the bar fits');
  const pill = await c.evaluate(() => {
    const pill = document.querySelector('.stream-zoom-reset.floating').getBoundingClientRect();
    const stage = document.querySelector('.stream-view').getBoundingClientRect();
    const bar = document.querySelector('.stream-bar').getBoundingClientRect();
    return pill.bottom <= bar.top + 0.5 && pill.right <= stage.right && pill.top >= stage.top;
  });
  check(pill, 'its percentage floats above the bar, inside the stream');
  await shot(c, '04-carol-pinched');
  await c.tap(reset);
  await c.waitForTimeout(300);
  check((await geometry(c)).percent === null, 'tapping it fits the stream again');

  // A new stream starts fitted: Alice stops and goes live again.
  await a.click('.voice-bar button[aria-label="Stop sharing your screen"]');
  await c.waitForSelector('.stream-view', { state: 'detached', timeout: 10000 });
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await c.waitForSelector(`${tile(alice.name)} .voice-tile-watch`, { timeout: 10000 });
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  check((await geometry(c)).percent === null, 'a new stream starts fitted');
  console.log('OK');
} finally {
  await browser.close();
}
