// YouTube and GIF privacy in a real browser: by default a YouTube link gets its player and a GIF
// loads at once; with Settings → Privacy's two options off (Bob, on a phone), nothing is asked
// of YouTube or Klipy until Play / Show, and the GIF picker warns before loading previews.
// YouTube and Klipy are stood in for (nothing leaves the machine), with a made-up Klipy key.
//   node e2e/serve.mjs &   then   node e2e/embedprivacy.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// By host: the app has modules called youtube.js too.
const THIRD_PARTY = /^https?:\/\/([^/]*\.)?(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|klipy\.com)\//;
// A 2×2 PNG for Klipy's files, and a page for YouTube's player.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHxkzIHMQMgxIHAAZ8hfpEtkwIwAAAABJRU5ErkJggg==', 'base64');

// Answers YouTube and Klipy for `page` and returns the list of what it asked them.
async function standIn(page) {
  const asked = [];
  await page.context().route(THIRD_PARTY, (route) => {
    asked.push(route.request().url());
    if (/klipy/.test(route.request().url())) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.fulfill({ contentType: 'text/html', body: '<body style="background:#c00;color:#fff">stand-in player</body>' });
  });
  return asked;
}

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = admin.page;
  const b = bob.page;
  const askedA = await standIn(a);
  const askedB = await standIn(b);

  // A made-up Klipy key, so the GIFs tab shows (its searches fail, which is fine here).
  await a.goto(`${BASE}/settings`);
  await a.fill('#admin-klipyApiKey', 'e2e-not-a-real-key');
  await a.click('.admin-setting button:has-text("Save")');
  await a.waitForSelector('text=Set here: …-key');

  // Bob turns both off in Settings → Privacy.
  await b.goto(`${BASE}/settings#privacy`);
  await b.uncheck('label:has-text("Show YouTube videos straight away") input');
  await b.uncheck('label:has-text("Show GIFs straight away") input');
  const prefs = await b.evaluate(() => JSON.parse(localStorage.getItem('privacy')));
  if (prefs.youtubeEmbeds !== false || prefs.gifs !== false) throw new Error(`privacy not saved: ${JSON.stringify(prefs)}`);
  await b.locator('label:has-text("Show GIFs straight away")').scrollIntoViewIfNeeded();
  await shot(b, 'settings');

  await openChat(b, admin.id);
  await openChat(a, bob.id);
  await send(a, 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await send(a, '![GIF](https://static.klipy.com/ii/e2e/cat.webp#gif&w=498&h=374)');

  // The admin (defaults) gets the player and the GIF at once.
  await a.waitForSelector('.youtube-wrapper iframe[src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]', { timeout: 10000 });
  await a.waitForSelector('img.attachment-media[src*="static.klipy.com"]');
  console.log('default: player and GIF load at once');

  // Bob: placeholders, nothing asked of YouTube or Klipy.
  await b.waitForSelector('.youtube-placeholder', { timeout: 10000 });
  await b.waitForSelector('.attachment-gif-hidden');
  await b.waitForTimeout(1000);
  if (await b.$('.youtube-wrapper iframe, img.attachment-media[src*="klipy"]')) throw new Error('loaded despite the setting');
  if (askedB.length) throw new Error(`asked third parties: ${askedB.join(', ')}`);
  const layout = await b.evaluate(() => {
    const gif = document.querySelector('.attachment-gif-hidden').getBoundingClientRect();
    const yt = document.querySelector('.youtube-placeholder').getBoundingClientRect();
    return { gif: [gif.width, gif.height], ytRight: yt.right, overflow: document.documentElement.scrollWidth > window.innerWidth, w: window.innerWidth };
  });
  // 498×374 drawn in a box of that shape (within the column).
  if (Math.abs(layout.gif[0] / layout.gif[1] - 498 / 374) > 0.05) throw new Error(`GIF box shape ${layout.gif}`);
  if (layout.overflow || layout.ytRight > layout.w) throw new Error('placeholders overflow the phone screen');
  await shot(b, 'placeholders');
  console.log(`private: placeholders only (GIF box ${layout.gif.map(Math.round).join('×')}), nothing asked of YouTube or Klipy`);

  // Play loads the player (autoplaying); Show loads the GIF.
  await b.click('button[aria-label="Play YouTube video"]');
  await b.waitForSelector('.youtube-wrapper iframe[src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"]');
  await b.click('button[aria-label="Show GIF"]');
  await b.waitForSelector('img.attachment-media[src*="static.klipy.com"]');
  await b.waitForTimeout(500);
  if (!askedB.some((u) => u.includes('youtube-nocookie')) || !askedB.some((u) => u.includes('klipy'))) throw new Error(`not loaded after tapping: ${askedB}`);
  await shot(b, 'shown');
  console.log('private: Play and Show load them');

  // The GIF picker warns first and asks nothing (not even our server) until accepted.
  askedB.length = 0;
  let gifRequests = 0;
  b.on('request', (r) => { if (/\/api\/gifs\//.test(r.url())) gifRequests += 1; });
  await b.click('button[aria-label="Emoji"]');
  await b.click('role=tab[name="GIFs"]');
  await b.waitForSelector('.gif-picker-warning');
  await b.waitForTimeout(800);
  if (gifRequests || askedB.length) throw new Error(`picker loaded before accepting: ${gifRequests} searches, ${askedB}`);
  await shot(b, 'picker-warning');
  await b.click('button:has-text("Show GIFs anyway")');
  await b.waitForFunction(() => !document.querySelector('.gif-picker-warning'));
  await b.waitForTimeout(800);
  if (!gifRequests) throw new Error('no GIF request after accepting');
  console.log('private: GIF picker warns, loads only after Show GIFs anyway');

  // The admin's picker (defaults) has no warning.
  await a.click('button[aria-label="Emoji"]');
  await a.click('role=tab[name="GIFs"]');
  await a.waitForSelector('.gif-picker-views');
  if (await a.$('.gif-picker-warning')) throw new Error('warning with GIFs on');
  if (!askedA.length) throw new Error('admin never loaded anything from the stand-ins');
  console.log('default: picker has no warning');
  console.log('OK');
} finally {
  await browser.close();
}
