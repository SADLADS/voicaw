// Scrollbars: styled (and grabbable) with a mouse, the system's overlay bar on touch screens,
// which takes no room and can't be tapped or dragged (Android's Chrome makes any styled bar a
// classic one). Measures every scrolling element's bar in a long chat, desktop and phone. The
// phone also plays a browser without scrollbar-color/scrollbar-width (Chrome before 121, older
// WebViews, Samsung Internet), which applies the ::-webkit-scrollbar rules instead.
//   node e2e/serve.mjs &   then   node e2e/scrollbars.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];

// Headless Chrome hides scrollbars unless told not to.
const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await openChat(alice.page, bob.id);
  for (let i = 0; i < 30; i++) await send(alice.page, `message ${i}`);
  await alice.page.waitForSelector('text=message 29');
  await openChat(bob.page, alice.id);
  await bob.page.waitForSelector('text=message 29');

  // [class, vertical bar width, horizontal bar height] for each element that scrolls.
  const bars = (page) => page.evaluate(() => [...document.querySelectorAll('*')].flatMap((el) => {
    const s = getComputedStyle(el);
    const scrolls = (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1)
      || (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1);
    if (!scrolls) return [];
    const bw = (a, b) => parseFloat(s[a]) + parseFloat(s[b]);
    return [[el.className || el.tagName,
      el.offsetWidth - el.clientWidth - bw('borderLeftWidth', 'borderRightWidth'),
      el.offsetHeight - el.clientHeight - bw('borderTopWidth', 'borderBottomWidth')]];
  }));

  const desktop = await bars(alice.page);
  const phone = await bars(bob.page);
  await bob.page.addStyleTag({ content: '* { scrollbar-color: auto !important; scrollbar-width: auto !important; }' });
  phone.push(...await bars(bob.page));
  if (!desktop.length || !phone.length) throw new Error('nothing scrolls');
  if (!desktop.some(([, w]) => w > 0)) throw new Error(`desktop: no styled bars ${JSON.stringify(desktop)}`);
  const grabbable = phone.filter(([, w, h]) => w > 0 || h > 0);
  if (grabbable.length) throw new Error(`phone: classic bars ${JSON.stringify(grabbable)}`);
  if (dir) {
    await alice.page.screenshot({ path: `${dir}/scrollbars-desktop.png` });
    await bob.page.screenshot({ path: `${dir}/scrollbars-phone.png` });
  }
  console.log(`scrollbars: ok (desktop ${JSON.stringify(desktop)}, phone ${phone.length} scroller(s), overlay bars only)`);
} catch (err) {
  console.error('scrollbars: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
