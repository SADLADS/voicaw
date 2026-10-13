// Following new messages: a webhook posting many embeds quickly, each with pictures from
// another site that have no size given (so every row grows when its pictures load, at random
// moments), must leave the chat at the bottom, and the next message must still scroll it there.
// Scrolling up must still stop the following.
//   node e2e/serve.mjs &   then   node e2e/scrollpin.mjs [screenshot dir]
import http from 'node:http';
import sharp from 'sharp';
import { launchChrome, signUp } from './helpers.mjs';

const shots = process.argv[2];

// A slow picture site: each picture arrives after 20-600 ms, at a height of its own.
const pictures = new Map();
const picture = async (height) => {
  if (!pictures.has(height)) {
    pictures.set(height, await sharp({ create: { width: 300, height, channels: 3, background: '#d04040' } }).png().toBuffer());
  }
  return pictures.get(height);
};
const site = http.createServer(async (req, res) => {
  const height = Number(new URL(req.url, 'http://x').searchParams.get('h')) || 200;
  const body = await picture(height);
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(body);
  }, 20 + Math.random() * 580);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}`;

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const a = alice.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Films');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.click('button[aria-label="Edit general"]');
  await a.click('[role="tab"]:has-text("Webhooks")');
  await a.click('button:has-text("New Webhook")');
  await a.waitForSelector('button:has-text("Copy Webhook URL")');
  await a.click('button:has-text("Copy Webhook URL")');
  await a.waitForSelector('text=Copied!');
  const url = await a.evaluate(() => navigator.clipboard.readText());
  await a.keyboard.press('Escape');

  let n = 0;
  const postFilm = async () => {
    n += 1;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Cineworld',
        embeds: [{
          title: `Film ${n}`,
          description: `Showing at ${n % 12 + 10}:00.\nScreen ${n % 9 + 1}`,
          thumbnail: { url: `${siteUrl}/thumb-${n}.png?h=${150 + (n * 37) % 200}` },
          image: { url: `${siteUrl}/poster-${n}.png?h=${200 + (n * 53) % 400}` },
        }],
      }),
    });
    if (res.status !== 204) throw new Error(`webhook: ${res.status} ${await res.text()}`);
  };
  // How far the chat is from the bottom, measured after paint.
  const gap = () => a.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const s = document.querySelector('.message-scroller');
      resolve(Math.round(s.scrollHeight - s.scrollTop - s.clientHeight));
    };
    channel.port2.postMessage(null);
  })));
  const settle = async () => {
    // Every picture loaded, then a little more for the last corrections.
    // (lazy ones far from view never load, so only those near it).
    await a.waitForFunction(() => {
      const s = document.querySelector('.message-scroller').getBoundingClientRect();
      return [...document.querySelectorAll('.message-scroller img')].every((img) => {
        const r = img.getBoundingClientRect();
        return img.complete || r.bottom < s.top - 1000 || r.top > s.bottom + 1000;
      });
    }, null, { timeout: 20000 });
    await a.waitForTimeout(800);
  };

  for (let round = 1; round <= 5; round += 1) {
    // A burst, the way a bot announcing a day's films posts them.
    for (let i = 0; i < 15; i += 1) {
      await postFilm();
      await a.waitForTimeout(Math.random() * 120);
    }
    await a.waitForSelector(`.embed-title:has-text("Film ${n}")`, { timeout: 15000 });
    await settle();
    const after = await gap();
    if (after > 4) {
      if (shots) await a.screenshot({ path: `${shots}/scrollpin-stuck-${round}.png` });
      throw new Error(`round ${round}: ${after}px from the bottom after a burst of ${n} films`);
    }
    console.log(`round ${round}: at the bottom after ${n} films`);
  }

  // Scrolling up stops the following; the next message leaves the view where it was.
  await a.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop -= 600; });
  await a.waitForTimeout(300);
  const before = await gap();
  await postFilm();
  await a.waitForSelector(`.embed-title:has-text("Film ${n}")`, { timeout: 15000 });
  await settle();
  const later = await gap();
  if (later < before) throw new Error(`scrolled up ${before}px, but a new message moved it to ${later}px`);
  console.log(`scrolled up: stays put (${before}px → ${later}px from the bottom)`);

  // Back at the bottom (the user scrolling down): following again.
  await a.evaluate(() => { const s = document.querySelector('.message-scroller'); s.scrollTop = s.scrollHeight; });
  await a.waitForTimeout(300);
  await postFilm();
  await a.waitForSelector(`.embed-title:has-text("Film ${n}")`, { timeout: 15000 });
  await settle();
  if (await gap() > 4) throw new Error('back at the bottom, but not following new messages');
  if (shots) await a.screenshot({ path: `${shots}/scrollpin.png` });
  console.log('scrollpin e2e: ok');
} catch (err) {
  console.error('scrollpin e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
}
