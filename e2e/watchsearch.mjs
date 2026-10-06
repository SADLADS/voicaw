// Watch Together's YouTube search in real browsers (real YouTube, needs the internet): Alice and
// Bob join a voice channel; Alice searches, plays a result, searches again and queues two more
// (each marked Added, the rest still addable), and Bob sees them queued. A link still goes
// straight in. Carol searches on a phone. Settings → Privacy's YouTube switch off: no thumbnails.
//   node e2e/serve.mjs &   then   node e2e/watchsearch.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

async function search(page, query) {
  await page.fill('.watch-party-add input', query);
  const label = await page.textContent('.watch-party-add button[type="submit"]');
  check(label.trim() === 'Search', `the button says Search for "${query}"`);
  await page.click('.watch-party-add button[type="submit"]');
  await page.waitForSelector('.watch-party-result', { timeout: 20000 });
  return page.$$eval('.watch-party-result', (items) => items.map((li) => ({
    title: li.querySelector('.watch-party-result-title').textContent,
    meta: li.querySelector('.watch-party-item-meta').textContent,
    thumb: li.querySelector('.watch-party-result-thumb')?.src ?? null,
    button: li.querySelector('button').textContent,
  })));
}

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Search Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Cinema');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.guild-channel-link:has-text("cinema")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click('.watch-party-toggle');
  console.log('alice and bob in voice');

  await a.click('.watch-party-toggle');
  await a.waitForSelector('.watch-party-panel .watch-party-empty');
  const placeholder = await a.getAttribute('.watch-party-add input', 'placeholder');
  check(placeholder === 'Search YouTube or paste a link', 'the box offers search or a link');
  await a.fill('.watch-party-add input', 'https://vimeo.com/1');
  check((await a.textContent('.watch-party-add button[type="submit"]')).trim() === 'Play', 'a link makes the button Play');
  await a.click('.watch-party-add button[type="submit"]');
  check((await a.textContent('.watch-party-error')) === "That isn't a YouTube video link.", 'a link to another site is refused, not searched');

  const zoo = await search(a, 'me at the zoo');
  check(zoo.length >= 5, `results come back (${zoo.length})`);
  check(zoo.some((r) => /zoo/i.test(r.title)), `"Me at the zoo" is among them (${zoo[0].title})`);
  check(zoo.every((r) => r.thumb?.startsWith('https://i.ytimg.com/vi/')), 'each has a thumbnail');
  check(zoo.every((r) => r.button === 'Play'), 'nothing is playing, so each says Play');
  check(zoo.some((r) => / · \d+:\d\d$/.test(r.meta)), `lengths show (${zoo[0].meta})`);
  await a.waitForFunction(() => [...document.querySelectorAll('.watch-party-result-thumb')].slice(0, 3).every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15000 });
  await shot(a, '01-results');

  const zooIndex = zoo.findIndex((r) => /zoo/i.test(r.title));
  await a.click(`.watch-party-result:nth-child(${zooIndex + 1}) button`);
  await a.waitForSelector('.watch-party-player.docked iframe', { timeout: 15000 });
  await b.waitForSelector('.watch-party-player.docked iframe', { timeout: 15000 });
  check(true, 'a result plays for everyone');
  await a.waitForSelector(`.watch-party-result:nth-child(${zooIndex + 1}) button:has-text("Added")`);
  const others = await a.$$eval('.watch-party-result button', (bs) => bs.filter((x) => !x.disabled).map((x) => x.textContent));
  check(others.length === zoo.length - 1 && others.every((x) => x === 'Add'), 'it shows Added, the others now say Add');

  const rick = await search(a, 'rick astley never gonna give you up');
  check(rick.every((r) => r.button === 'Add'), 'a new search starts with nothing added');
  await a.click('.watch-party-result:nth-child(1) button');
  await a.waitForSelector('.watch-party-result:nth-child(1) button:has-text("Added")');
  await a.click('.watch-party-result:nth-child(2) button');
  await a.waitForSelector('.watch-party-result:nth-child(2) button:has-text("Added")');
  const queued = await a.$$eval('.watch-party-queue .watch-party-item-title', (els) => els.map((e) => e.textContent));
  check(queued.length === 2 && queued[0] === rick[0].title && queued[1] === rick[1].title, `both queued in order (${queued.join(' | ')})`);
  await b.waitForFunction((n) => document.querySelectorAll('.watch-party-queue .watch-party-item').length === n, 2, { timeout: 10000 });
  check(true, 'Bob sees them queued');
  check((await b.textContent('.watch-party-activity')).includes('added'), 'the activity log says who added');
  await shot(a, '02-queued');

  await a.click('button[aria-label="Close the search results"]');
  check(!(await a.$('.watch-party-results')), 'closing the results hides them');

  // A link still goes straight in.
  await a.fill('.watch-party-add input', 'https://www.youtube.com/watch?v=9bZkp7q19f0');
  await a.click('.watch-party-add button[type="submit"]');
  await a.waitForFunction(() => document.querySelectorAll('.watch-party-queue .watch-party-item').length === 3, null, { timeout: 15000 });
  check(!(await a.$('.watch-party-results')), 'a pasted link is added without searching');

  // Carol on a phone.
  await c.goto(a.url().replace(/^https?:\/\/[^/]+/, BASE));
  await c.waitForSelector('.voice-view-join', { timeout: 15000 });
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-bar-status.connected, .voice-view-leave', { timeout: 20000 }).catch(() => {});
  if (!(await c.$('.watch-party-panel'))) await c.click('.watch-party-toggle');
  await c.waitForSelector('.watch-party-add input', { timeout: 15000 });
  const phone = await search(c, 'lofi');
  check(phone.length > 0, 'the phone searches too');
  const fits = await c.evaluate(() => {
    const list = document.querySelector('.watch-party-results-list').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('.watch-party-result button')].slice(0, 3).map((x) => x.getBoundingClientRect());
    return list.right <= innerWidth + 0.5 && buttons.every((r) => r.right <= innerWidth + 0.5 && r.width > 0) && document.documentElement.scrollWidth <= innerWidth;
  });
  check(fits, 'results and buttons fit the phone, no sideways scroll');
  await c.evaluate(() => document.querySelector('.watch-party-results')?.scrollIntoView());
  await shot(c, '03-phone');

  // YouTube held back in Settings → Privacy: no thumbnails.
  await b.evaluate(() => localStorage.setItem('privacy', JSON.stringify({ ...JSON.parse(localStorage.getItem('privacy') ?? '{}'), youtubeEmbeds: false })));
  await b.reload();
  await b.waitForSelector('.voice-view-join, .voice-bar-status.connected', { timeout: 20000 });
  if (await b.$('.voice-view-join')) await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  if (!(await b.$('.watch-party-add input'))) await b.click('.watch-party-toggle');
  await b.waitForSelector('.watch-party-add input', { timeout: 15000 });
  const held = await search(b, 'me at the zoo');
  check(held.every((r) => r.thumb === null), 'with YouTube held back, no thumbnails');
  console.log('all good');
} finally {
  await browser.close();
}
