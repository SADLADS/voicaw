// Forwarding messages: Bob DMs Alice a picture; she right-clicks it → Forward, picks a guild
// channel (marked "Not encrypted"), which opens with "Forwarding a message" over the box; she
// adds a line and sends: the forward (Forwarded, the text, the picture, its first time), then
// her line. Bob sees both, and nobody was pinged. Bob deletes his DM: the forwarded picture
// still loads after a reload (the upload registry keeps it). The forward's hover button sends
// it on to Alice's notes as the original (one "Forwarded", not two); it can't be edited. A
// phone: hold → Forward → a DM, the mic gives way to Send, which sends it alone.
//   node e2e/serve.mjs &   then   node e2e/forward.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { BASE, launchChrome, signUp, openChat, send, makeFriends, devices } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const picture = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
     <rect width="480" height="320" fill="#f84"/><circle cx="240" cy="230" r="90" fill="#fd4"/>
   </svg>`)).png().toBuffer();

const row = (page, text) => page.locator('.each-dm-message-wrapper', { hasText: text }).last();
// The picture in a row has loaded (decrypted).
const pictureLoaded = (page, text) => page.waitForFunction((t) => {
  const rows = [...document.querySelectorAll('.each-dm-message-wrapper')].filter((r) => r.textContent.includes(t));
  const img = rows.at(-1)?.querySelector('img.attachment-media');
  return img && img.complete && img.naturalWidth > 0;
}, text, { timeout: 20000 });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  const b = bob.page;
  const guild = await api(a, 'POST', '/guilds', { name: 'Forwards' });
  const general = guild.channels[0];
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);

  console.log('a DM forwarded to a guild channel');
  await openChat(b, alice.id);
  const [chooser] = await Promise.all([
    b.waitForEvent('filechooser'),
    b.click('.attach-button').then(() => b.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: picture });
  await send(b, `sunset at the beach <@${alice.id}>`);
  await openChat(a, bob.id);
  await pictureLoaded(a, 'sunset at the beach');

  // On its time (the picture has its own menu).
  await row(a, 'sunset at the beach').locator('small span[title]').first().click({ button: 'right' });
  await a.click('.context-menu [role="menuitem"]:has-text("Forward")');
  await a.waitForSelector('.forward-dialog');
  const rows = await a.$$eval('.forward-dialog-row', (els) => els.map((e) => e.textContent.trim()));
  check(rows[0] === 'Notes', 'the dialog lists your notes first');
  check(rows.some((r) => r.startsWith(bob.name)) && rows.some((r) => r.startsWith(carol.name)), 'then the DMs');
  check(rows.some((r) => r.startsWith('general') && r.includes('Forwards') && r.includes('Not encrypted')), 'and the guild channel, marked not encrypted');
  const preview = await a.textContent('.forward-dialog-preview');
  check(preview.includes('📎 sunset.png') && preview.includes(`@${alice.name}`), `the message shows on top, its file and mention by name (${preview})`);
  await shot(a, '01-dialog');
  await a.fill('.forward-dialog input[type="search"]', 'gen');
  check(await a.locator('.forward-dialog-row').count() === 1, 'search narrows it');
  await a.click('.forward-dialog-row');
  await a.waitForURL(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('.forward-bar');
  check((await a.textContent('.forward-bar')).includes('sunset at the beach'), 'the channel opens with the message waiting over the box');
  await shot(a, '02-waiting');

  await b.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await b.waitForSelector('#dm-input');
  await send(a, 'thought you would like this');
  await a.waitForSelector('text=thought you would like this');
  check(await a.locator('.forward-bar').count() === 0, 'sending takes the bar away');
  for (const [who, page] of [['alice', a], ['bob', b]]) {
    await page.waitForSelector('.message-forward', { timeout: 20000 });
    await pictureLoaded(page, 'sunset at the beach');
    const texts = await page.$$eval('.dm-message-content', (els) => els.map((e) => e.textContent));
    const at = texts.findIndex((t) => t.includes('sunset at the beach'));
    check(at !== -1 && texts[at + 1]?.includes('thought you would like this'), `${who}: the forward, then the line added`);
  }
  const forward = b.locator('.message-forward').last();
  check((await forward.textContent()).trim().startsWith('Forwarded'), 'it says Forwarded');
  check(await forward.locator('.message-forward-time').count() === 1, 'with when it was first sent');
  check(await b.locator('.each-dm-message-wrapper.mentioned').count() === 0, "its mention isn't a ping");
  await shot(b, '03-guild');

  console.log('the original deleted');
  await openChat(b, alice.id);
  await row(b, 'sunset at the beach').hover();
  await b.click('.each-dm-message-wrapper:has-text("sunset at the beach") .trash-button', { modifiers: ['Shift'] });
  await b.waitForSelector('text=sunset at the beach', { state: 'detached' });
  await a.reload();
  await a.waitForSelector('.message-forward');
  await pictureLoaded(a, 'sunset at the beach');
  check(true, 'the forwarded picture still loads after a reload');

  console.log('forwarded on, to notes');
  await row(a, 'sunset at the beach').hover();
  await a.click('.each-dm-message-wrapper:has(.message-forward) .message-menu .icon-button:has(svg.fa-share)');
  await a.waitForSelector('.forward-dialog');
  check(await a.locator('.forward-dialog-row:has-text("Not encrypted")').count() === 0, 'from a guild, nothing is marked');
  await a.click('.forward-dialog-row:has-text("Notes")');
  await a.waitForURL(`${BASE}/dm/notes`);
  await a.waitForSelector('.forward-bar');
  await a.click('#dm-input');
  await a.keyboard.press('Enter');
  await a.waitForSelector('.message-forward', { timeout: 20000 });
  await pictureLoaded(a, 'sunset at the beach');
  check(await a.locator('.message-forward .message-forward').count() === 0, 'a forward of a forward is the original');
  await row(a, 'sunset at the beach').locator('.message-forward-label').click({ button: 'right' });
  const items = await a.$$eval('.context-menu [role="menuitem"] .context-menu-label', (els) => els.map((e) => e.firstChild.textContent));
  check(items.includes('Forward') && !items.includes('Edit Message'), `it can be forwarded again, not edited (${items.join(', ')})`);
  await a.keyboard.press('Escape');
  await shot(a, '04-notes');

  console.log('a phone');
  const c = carol.page;
  await openChat(a, carol.id);
  await send(a, 'pass this on');
  await openChat(c, alice.id);
  await c.waitForSelector('text=pass this on', { timeout: 20000 });
  const box = await c.locator('.dm-message-content', { hasText: 'pass this on' }).boundingBox();
  const cdp = await c.context().newCDPSession(c);
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await c.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.waitForSelector('.action-sheet');
  await c.tap('.action-sheet-item:has-text("Forward")');
  await c.waitForSelector('.forward-dialog');
  const width = await c.$eval('.forward-dialog', (el) => el.getBoundingClientRect().width);
  check(width <= c.viewportSize().width, 'the dialog fits the phone');
  await shot(c, '05-phone-dialog');
  await c.tap(`.forward-dialog-row:has-text("${bob.name}")`);
  await c.waitForURL(`${BASE}/dm/${bob.id}`);
  await c.waitForSelector('.forward-bar');
  check(await c.locator('button[aria-label="Record a voice message"]').count() === 0, 'Send, not the mic, while a forward waits');
  await shot(c, '06-phone-waiting');
  await c.tap('button.send-button');
  await c.waitForSelector('.message-forward', { timeout: 20000 });
  await openChat(b, carol.id);
  await b.waitForSelector('.message-forward:has-text("pass this on")', { timeout: 20000 });
  check(true, 'Bob gets it from Carol');

  console.log('forward: ok');
} catch (err) {
  if (dir) for (const [i, ctx] of browser.contexts().entries()) await ctx.pages()[0]?.screenshot({ path: `${dir}/failed-${i}.png` }).catch(() => {});
  console.error('forward: FAILED', err.message.split('\n').slice(0, 3).join(' | '), err.stack.split('\n').find((l) => l.includes('forward.mjs')));
  process.exitCode = 1;
} finally {
  await browser.close();
}
