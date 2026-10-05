// NSFW channels: flagged in the channel dialog (tag in the header), closed behind the age gate
// ("I am 18 or over", kept as just that answer; not asked again), their media covered with
// "NSFW" for everyone (a linked image, a webhook embed's image, a YouTube video, which loads
// nothing until uncovered), a spoiler in one covered just once ("Spoiler"), tapping uncovers on
// a phone, and Settings → Content's switch (saved to the account) uncovering all but spoilers.
//   node e2e/serve.mjs &   then   node e2e/nsfw.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, send, BASE, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
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
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const twist = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
     <rect width="480" height="320" fill="#2a6"/>
     <text x="30" y="200" font-size="64" font-family="sans-serif" fill="#fff">THE TWIST</text>
   </svg>`)).png().toBuffer();

// The labels on the covers in the chat, in order.
const covers = (page) => page.$$eval('.attachment-spoiler-reveal', (bs) => bs.map((b) => b.textContent));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;

  const guild = await api(a, 'POST', '/guilds', { name: 'Gallery' });
  const general = guild.channels[0];
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);

  // Alice flags #general as NSFW in its dialog.
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  check(!(await a.$('.channel-nsfw-tag')), 'no NSFW tag before');
  await a.click('button[aria-label="Edit general"]');
  await a.check('label:has-text("NSFW channel") input');
  await shot(a, '1-dialog');
  await a.click('button:has-text("Save")');
  await a.waitForSelector('.channel-nsfw-tag');
  check(true, 'the header has an NSFW tag once flagged');

  // The age gate: an NSFW channel opens only once you've ticked "I am 18 or over".
  const passGate = async (page, who) => {
    await page.waitForSelector('.nsfw-gate');
    check(!(await page.$('#dm-input')) && !(await page.$('.message')), `${who}: behind the gate, no messages and no message box`);
    check(!(await page.$('.pins-button')) && !(await page.$('.threads-button')), `${who}: no pins or threads to peek at`);
    const go = page.locator('.nsfw-gate button:has-text("Continue")');
    check(await go.isDisabled(), `${who}: Continue waits for the tick`);
    await page.check('.nsfw-gate label:has-text("I am 18 or over") input');
    await go.click();
    await page.waitForSelector('#dm-input');
    const prefs = await api(page, 'GET', '/preferences');
    check(prefs.adultConfirmed === true && Object.keys(prefs).every((k) => typeof prefs[k] === 'boolean'), `${who}: only the answer is kept (${JSON.stringify(prefs)})`);
  };
  await shot(a, '1b-gate');
  await passGate(a, 'alice');

  // A linked image and a YouTube link, a webhook's embed with an image, and a spoiler upload.
  await api(a, 'POST', `/channels/${general.id}/messages`, {
    content: `look ![logo](${BASE}/logo192.png) https://youtu.be/dQw4w9WgXcQ`,
  });
  const hook = await api(a, 'POST', `/channels/${general.id}/webhooks`, { name: 'Art Bot' });
  await fetch(`${BASE}/api/webhooks/${hook.id}/${hook.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{ title: 'New piece', image: { url: `${BASE}/logo512.png` } }] }),
  });
  const [chooser] = await Promise.all([
    a.waitForEvent('filechooser'),
    a.click('.attach-button').then(() => a.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'ending.png', mimeType: 'image/png', buffer: twist });
  await a.click('button[aria-label="Mark ending.png as spoiler"]');
  await send(a, 'no peeking');

  for (const [who, page] of [['alice', a], ['bob', b]]) {
    if (page === b) {
      await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
      await shot(b, '1c-phone-gate');
      await passGate(b, 'bob');
    }
    await page.waitForFunction(() => document.querySelectorAll('.attachment-spoiler').length === 4, null, { timeout: 20000 })
      .catch(async (err) => {
        console.error(`${who} covers:`, await page.$$eval('.attachment-spoiler-reveal', (bs) => bs.map((x) => x.getAttribute('aria-label'))));
        throw err;
      });
    check(JSON.stringify(await covers(page)) === JSON.stringify(['NSFW', 'NSFW', 'NSFW', 'Spoiler']),
      `${who}: image, YouTube and embed say NSFW, the spoiler just Spoiler (${await covers(page)})`);
    check(!(await page.$('iframe')), `${who}: nothing loaded from YouTube`);
    check(!(await page.$('[data-gallery-item]')), `${who}: nothing covered is in the image viewer`);
    const blurred = await page.$$eval('.attachment-spoiler-content', (els) => els.every((el) => getComputedStyle(el).filter.includes('blur')));
    check(blurred, `${who}: every cover is blurred`);
  }
  await shot(a, '2-desktop-covered');
  await shot(b, '3-phone-covered');

  // Bob taps the linked image and the video: each uncovers just itself.
  await b.tap('.attachment-spoiler-reveal[aria-label^="NSFW: logo"]');
  check(await b.$('img[alt="logo"][data-gallery-item]'), 'bob: the tapped image shows, in the viewer');
  check(!(await b.$('.image-viewer')), 'bob: the tap did not also open the viewer');
  await b.tap('.attachment-spoiler-reveal[aria-label^="NSFW: YouTube"]');
  // On a phone the chat only holds the video's thumbnail (tapping it plays full screen, UrlPreviews).
  await b.waitForSelector('img[src*="i.ytimg.com/vi/dQw4w9WgXcQ"]', { timeout: 5000 }).catch(() => null);
  check(await b.$('img[src*="i.ytimg.com/vi/dQw4w9WgXcQ"]'), "bob: the video's thumbnail shows once uncovered");
  check((await covers(b)).length === 2, 'bob: the embed and the spoiler stay covered');
  check((await covers(a)).length === 4, "alice: bob's taps don't uncover hers");
  await shot(b, '4-phone-revealed');

  // Settings → Content: Bob turns the blur off; it's saved to his account.
  await b.goto(`${BASE}/settings#content`);
  const toggle = b.locator('label:has-text("Blur media in NSFW channels") input');
  check(await toggle.isChecked(), 'the blur is on by default');
  await toggle.uncheck();
  await b.waitForFunction(async () => {
    const res = await fetch('/api/preferences', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).blurNsfw === false;
  });
  await shot(b, '5-settings');
  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('img[alt="logo"]');
  await b.waitForSelector('.embed-image');
  check(JSON.stringify(await covers(b)) === JSON.stringify(['Spoiler']), `bob: only the spoiler is covered now (${await covers(b)})`);
  await b.reload();
  await b.waitForSelector('.embed-image');
  check(JSON.stringify(await covers(b)) === JSON.stringify(['Spoiler']), 'bob: still so after a reload');
  check(!(await b.$('.nsfw-gate')), 'bob: not asked his age again after a reload');
  check((await covers(a)).length === 4, "alice: bob's setting is his own");
  await shot(b, '6-phone-blur-off');
  console.log('nsfw: ok');
} catch (err) {
  console.error('nsfw: FAILED', err.message.split('\n')[0]);
  if (process.env.DEBUG) {
    console.error(err.stack);
    for (const [i, ctx] of browser.contexts().entries()) await ctx.pages()[0]?.screenshot({ path: `${dir}/fail-${i}.png` });
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
