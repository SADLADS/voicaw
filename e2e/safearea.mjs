// Safe areas: on a phone with a home indicator and rounded corners (insets made up with CDP's
// Emulation.setSafeAreaInsetsOverride, iPhone sizes), the user panel's picture and settings cog
// sit above the indicator, landscape keeps the app clear of the notch, and with no insets
// (computer, older phones) the panel is as before.
//   node e2e/serve.mjs &   then   node e2e/safearea.mjs [dir]
import { launchChrome, signUp, devices } from './helpers.mjs';

const dir = process.argv[2];
const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 14'];

async function setInsets(page, insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  // Let the layout settle after paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  })));
}

function measure(page) {
  return page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const panel = document.querySelector('.user-panel');
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      panel: box('.user-panel'),
      avatar: box('.user-panel-avatar'),
      cog: box('a.user-panel-button[aria-label="Settings"]'),
      paddingBottom: panel && getComputedStyle(panel).paddingBottom,
    };
  });
}

// Phones open on the chat: swipe right (CDP touch events, as in panes.mjs) to the list with
// the user panel.
async function showList(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
  });
  const { width, height } = page.viewportSize();
  await touch('touchStart', 40, height * 0.5);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', 40 + (width * 0.7 * i) / 10, height * 0.5);
    await new Promise((r) => setTimeout(r, 16));
  }
  await touch('touchEnd');
  await cdp.detach();
  await page.waitForSelector('.main-wrapper.pane-list:not(.panes-moving) .user-panel');
}

function check(cond, what) {
  if (!cond) throw new Error(what);
}

const browser = await launchChrome();
try {
  // Phone, portrait: 34px home indicator at the bottom, 47px notch at the top.
  const phone = await signUp(browser, 'safe', iphone);
  const page = phone.page;
  await page.waitForSelector('.main-wrapper.pane-content');
  await showList(page);
  await setInsets(page, { top: 47, bottom: 34, left: 0, right: 0 });
  let m = await measure(page);
  check(m.paddingBottom === '34px', `portrait: padding-bottom is ${m.paddingBottom}, wanted 34px`);
  check(m.avatar.bottom <= m.vh - 34, `portrait: picture bottom ${m.avatar.bottom} is under the indicator (vh ${m.vh})`);
  check(m.cog.bottom <= m.vh - 34, `portrait: cog bottom ${m.cog.bottom} is under the indicator`);
  check(Math.abs(m.panel.bottom - m.vh) < 1, `portrait: panel ends at ${m.panel.bottom}, not the bottom edge ${m.vh}`);
  if (dir) await page.screenshot({ path: `${dir}/safearea-portrait.png` });
  console.log('safearea: portrait ok', JSON.stringify({ avatarBottom: m.avatar.bottom, cogBottom: m.cog.bottom, vh: m.vh }));

  // Tapping the cog still opens Settings.
  await page.tap('a.user-panel-button[aria-label="Settings"]');
  await page.waitForURL(/\/settings/);
  await page.goBack();
  await page.waitForSelector('.main-wrapper.pane-list .user-panel');

  // Phone, landscape: notch on the left, indicator at the bottom.
  await page.setViewportSize({ width: iphone.viewport.height, height: iphone.viewport.width });
  await setInsets(page, { top: 0, bottom: 21, left: 47, right: 47 });
  m = await measure(page);
  check(m.panel.left >= 47, `landscape: panel starts at ${m.panel.left}, under the notch`);
  check(m.avatar.bottom <= m.vh - 21, `landscape: picture bottom ${m.avatar.bottom} is under the indicator`);
  check(m.panel.right <= m.vw - 47 + 0.5 || m.panel.right <= m.vw / 2 + 1,
    `landscape: panel ends at ${m.panel.right}, under the right corner`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `landscape: page scrolls sideways by ${overflow}px`);
  if (dir) await page.screenshot({ path: `${dir}/safearea-landscape.png` });
  console.log('safearea: landscape ok', JSON.stringify({ panelLeft: m.panel.left, panelRight: m.panel.right, vw: m.vw }));

  // No insets (a computer, a phone without an indicator): 8px under the panel, edge to edge.
  const desk = await signUp(browser, 'safedesk');
  await desk.page.waitForSelector('.user-panel');
  m = await measure(desk.page);
  check(m.paddingBottom === '8px', `computer: padding-bottom is ${m.paddingBottom}, wanted 8px`);
  check(m.panel.left === 0 || m.panel.left > 0, 'computer: no panel');
  const rootPad = await desk.page.evaluate(() => getComputedStyle(document.getElementById('root')).paddingLeft);
  check(rootPad === '0px', `computer: #root padded by ${rootPad}`);
  if (dir) await desk.page.screenshot({ path: `${dir}/safearea-computer.png` });
  console.log('safearea: computer ok (8px, no side padding)');

  // Phone without insets: the same 8px as before.
  await setInsets(page, { top: 0, bottom: 0, left: 0, right: 0 });
  await page.setViewportSize(iphone.viewport);
  m = await measure(page);
  check(m.paddingBottom === '8px', `phone without insets: padding-bottom is ${m.paddingBottom}`);
  console.log('safearea: ok');
} catch (err) {
  console.error('safearea: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
