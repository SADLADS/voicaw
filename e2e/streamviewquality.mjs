// A viewer's Stream quality, through the e2e LiveKit (serve.mjs starts one): Alice shares at
// 1080p (the default), Bob watches the full-size copy, picks Data saver in the stream bar's
// menu and gets LiveKit's half-size copy (the menu says what arrives; remembered on the device),
// then Auto again brings the full size back. Not in the corner; the menu fits a phone.
//   node e2e/serve.mjs &   then   node e2e/streamviewquality.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const tile = (name) => `.voice-tile:has-text("${name}")`;
const qualityButton = '.stream-view .stream-bar button[aria-label="Stream quality"]';
const item = (name) => `.stream-view-quality-list [role="menuitemradio"]:has-text("${name}")`;

// Waits until the watched stream plays at a height between `min` and `max`; returns its size.
async function receiving(page, { min = 1, max = Infinity }, what) {
  try {
    await page.waitForFunction(({ min, max }) => {
      const v = document.querySelector('.stream-view video');
      return v && v.videoWidth > 0 && !v.paused && v.videoHeight >= min && v.videoHeight <= max;
    }, { min, max: max === Infinity ? 1e9 : max }, { timeout: 30000 });
  } catch {
    const now = await page.$eval('.stream-view video', (v) => `${v.videoWidth}x${v.videoHeight}`).catch(() => 'nothing');
    throw new Error(`${what}: receiving ${now}`);
  }
  return page.$eval('.stream-view video', (v) => ({ width: v.videoWidth, height: v.videoHeight }));
}

// A 1920x1080 screen for Chrome's fake capture (picked without the picker).
const browser = await launchChrome({
  args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen', '--screen-info={1920x1080}'],
});
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  for (const [who, page] of [['alice', a], ['bob', b]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Viewer Quality');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);

  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));

  // Alice goes live at the default, 1080p.
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.waitForSelector('.go-live-dialog');
  await a.click('.go-live-dialog button:has-text("Go Live")');
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  check(await a.locator(qualityButton).count() === 0, 'Stream quality offered on your own stream');

  // Bob watches: Auto, the full-size copy.
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  const full = await receiving(b, { min: 541 }, 'Auto is not the full size');
  console.log(`auto: bob receives ${full.width}x${full.height}`);
  await b.click(qualityButton);
  check(await b.getAttribute(item('Auto'), 'aria-checked') === 'true', 'Auto is not the default');
  await b.waitForSelector(`.stream-view-quality-list >> text=Receiving ${full.width} × ${full.height}`);
  const fits = await b.$eval('.stream-view-quality-list', (menu) => {
    const box = menu.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0;
  });
  check(fits, 'the menu is off the screen');
  await shot(b, '01-menu-auto');

  // Data saver: LiveKit's half-size copy.
  await b.click(item('Data saver'));
  check(await b.locator('.stream-view-quality-list').count() === 0, 'the menu stays open after a pick');
  const low = await receiving(b, { max: Math.ceil(full.height / 2) }, 'Data saver did not get the small copy');
  console.log(`data saver: bob receives ${low.width}x${low.height}`);
  await b.click(qualityButton);
  check(await b.getAttribute(item('Data saver'), 'aria-checked') === 'true', 'Data saver is not ticked');
  await b.waitForSelector(`.stream-view-quality-list >> text=Receiving ${low.width} × ${low.height}`);
  await shot(b, '02-menu-data-saver');
  await b.keyboard.press('Escape');
  check(await b.locator('.stream-view-quality-list').count() === 0, 'Escape does not close the menu');

  // Remembered on the device.
  check(await b.evaluate(() => localStorage.getItem('streamViewQuality')) === 'low', 'Data saver not remembered');

  // Auto again: back to full size.
  await b.click(qualityButton);
  await b.click(item('Auto'));
  await receiving(b, { min: 541 }, 'Auto did not bring the full size back');

  // The corner (on another page) has no room for it.
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector('.stream-view.corner');
  check(await b.locator('.stream-view.corner button[aria-label="Stream quality"]').count() === 0, 'Stream quality in the corner');

  // A phone watching: the button and its menu fit.
  const { page: p } = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await joinWith(p, link);
  await p.goto(`${BASE}${new URL(a.url()).pathname}`);
  await p.waitForSelector('.voice-view-join');
  await p.click('.voice-view-join');
  await p.waitForSelector('.voice-view-controls');
  await p.click(`${tile(alice.name)} .voice-tile-watch`);
  await receiving(p, {}, 'the phone does not play the stream');
  await p.click(qualityButton);
  const phoneFits = await p.$eval('.stream-view-quality-list', (menu) => {
    const box = menu.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
  });
  await shot(p, '03-phone-menu');
  check(phoneFits, 'the menu is wider than the phone');
  console.log('OK');
} finally {
  await browser.close();
}
