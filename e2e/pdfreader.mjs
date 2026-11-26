// The PDF reader (PDF reader in docs/uploads.md). Runs against the dev server or, better, a
// production build (where the Content-Security-Policy is, so PDF.js's worker, WebAssembly and
// data files are checked against it), as attachmenttypes.mjs:
//   E2E_WEB_PORT=5232 VITE_API_BASE_URL=/api/ VITE_WS_URL=ws://localhost:5232/ws \
//     npx vite build --config e2e/vite.config.mjs --outDir /tmp/<dir> --emptyOutDir
//   E2E_WEB_PORT=5232 npx vite preview --config e2e/vite.config.mjs --outDir /tmp/<dir> --port 5232 &
//   E2E_WEB_PORT=5232 node e2e/pdfreader.mjs [screenshot dir]
// - Alice attaches a 12-page PDF: its first page in the tray; Bob sees it and "12 pages" before
//   anything of the PDF itself is downloaded (the store's reads), with Open and Download;
// - PDF.js's data files kept for offline use once a PDF has been opened (the service worker);
// - Open: pages drawn, a page number typed jumps there, zoom, Contents, Find (a match on every
//   page), Back closes it and it reopens where it was left;
// - a locked PDF: no preview, the password asked for, a wrong one said so, then it opens;
// - a hostile PDF (scripts on opening and on a link, javascript:, Launch, a remote PDF, a form
//   submission, a field, XFA, a file attached inside): nothing runs, no dialog, nothing asked of
//   another site, only the plain web link opens a tab;
// - the same in a guild channel, and a webhook's PDF; light, Slack, Halloween; a phone (fits the
//   width, pinch zooms, Back).
import { mkdirSync, readFileSync } from 'node:fs';
import { BASE, devices, launchChrome, signUp, openChat, send } from './helpers.mjs';
import { makePdf, makeHostilePdf } from '../client/src/services/pdf/testPdfs.js';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const s3 = `http://localhost:${process.env.E2E_S3_PORT || 3100}`;
const reads = async () => (await fetch(`${s3}/__reads`)).json();
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
};

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', 'X-Voicaw-Session': JSON.parse(localStorage.getItem('login')).sid },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const guidePdf = () => Buffer.from(makePdf({
  pages: 12,
  outline: true,
  lines: ['The quick brown fox jumps over the lazy dog.', ...Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the guide, to fill the page.`)],
}));
const lockedPdf = readFileSync(new URL('../client/src/services/pdf/fixtures/locked.pdf', import.meta.url));

async function attach(page, name, buffer) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer });
}

const reader = (page) => page.locator('.pdf-reader');
const pageInput = (page) => page.locator('.pdf-reader-page-input');
const drawn = (page, n = 1) => page.waitForFunction((count) => {
  const canvases = [...document.querySelectorAll('.pdf-reader .page canvas')].filter((c) => c.width > 0);
  return canvases.length >= count;
}, n, { timeout: 20000 });
const csp = [];
const watch = (page) => page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const offsite = [];
  for (const user of [alice, bob]) {
    watch(user.page);
    user.page.on('request', (req) => { if (!/^(blob:|data:|http:\/\/localhost[:/])/.test(req.url())) offsite.push(req.url()); });
  }
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await fetch(`${s3}/__reads/clear`);

  // The first page in the tray while writing.
  await attach(alice.page, 'guide.pdf', guidePdf());
  await alice.page.locator('.attachment-tray img[alt="First page of guide.pdf"]').waitFor({ timeout: 20000 });
  await shot(alice.page, '1-tray');
  await send(alice.page, 'the guide');

  // Bob: the first page and the count, before anything of the PDF.
  const row = bob.page.locator('.each-dm-message-wrapper', { hasText: 'the guide' });
  const preview = row.locator('img.attachment-book-cover');
  await preview.waitFor({ timeout: 20000 });
  await bob.page.waitForFunction(() => [...document.querySelectorAll('img.attachment-book-cover')].some((i) => i.complete && i.naturalWidth > 0));
  const size = await preview.evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  check(size[0] <= 280 && size[1] <= 400 && Math.abs(size[0] / size[1] - 595 / 842) < 0.02, `first page drawn small (${size})`);
  check(/^12 pages · /.test(await row.locator('.attachment-file-size').textContent()), 'says 12 pages');
  const before = await reads();
  check(before.length >= 1 && new Set(before.map((r) => r.key)).size === 1 && before.every((r) => r.bytes < 60_000), `only the preview was downloaded before Open (${JSON.stringify(before)})`);
  check(await row.getByRole('button', { name: 'Download guide.pdf' }).isVisible(), 'Download button');
  await shot(bob.page, '2-chat');

  // Reading.
  await row.getByRole('button', { name: 'Open guide.pdf' }).click();
  await drawn(bob.page);
  check(await bob.page.locator('.pdf-reader-page-total').textContent() === 'of 12', 'of 12');
  check(bob.page.workers().some((w) => /pdf\.worker/.test(w.url())), 'PDF.js runs in its own worker (no fallback to the page)');
  check((await bob.page.locator('.pdf-reader-toolbar').boundingBox()).y === 0, 'reader covers the app');
  check(await bob.page.locator('.pdf-reader .textLayer span', { hasText: 'Page 1' }).count() >= 1, 'selectable text');
  await shot(bob.page, '3-reader');

  // PDF.js's data files: QuickJS (its PDF-JavaScript sandbox) isn't served at all; the service
  // worker (dev server or build) starts, opening a PDF keeps every file for offline use, and
  // they load with the network cut.
  // (A missing file may come back as the app's page, so it's the bytes that tell.)
  const isWasm = (path) => bob.page.evaluate(async (p) => {
    const res = await fetch(p);
    const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4);
    return res.ok && head.join() === '0,97,115,109';
  }, path);
  check(await isWasm('/pdfjs/wasm/openjpeg.wasm') && !(await isWasm('/pdfjs/wasm/quickjs-eval.wasm')), 'QuickJS is not served (its decoders are)');
  const hasWorker = await bob.page.evaluate(() => 'serviceWorker' in navigator && Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((resolve) => { setTimeout(() => resolve(false), 15000); }),
  ]));
  check(hasWorker, 'the service worker starts');
  // A first visit isn't the service worker's yet: it takes over from the next page load.
  if (hasWorker && !(await bob.page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await bob.page.reload();
    await bob.page.waitForSelector('#dm-input');
    await row.getByRole('button', { name: 'Open guide.pdf' }).click();
    await drawn(bob.page);
  }
  if (hasWorker) {
    const total = await bob.page.evaluate(async () => (await (await fetch('/pdfjs/files.json')).json()).length);
    // (Polled from here: waitForFunction takes an async check's promise as true.)
    const kept = () => bob.page.evaluate(async () => {
      const name = (await caches.keys()).find((n) => n.startsWith('pdfjs-'));
      return name ? (await (await caches.open(name)).keys()).filter((r) => !r.url.endsWith('files.json')).length : 0;
    });
    const until = Date.now() + 90000;
    while (await kept() < total) {
      if (Date.now() > until) throw new Error(`FAILED: only ${await kept()} of ${total} data files kept`);
      await bob.page.waitForTimeout(1000);
    }
    await bob.page.context().setOffline(true);
    const offline = await bob.page.evaluate(async () => Promise.all(
      ['/pdfjs/cmaps/UniJIS-UCS2-H.bcmap', '/pdfjs/wasm/openjpeg.wasm', '/pdfjs/standard_fonts/FoxitSerif.pfb'].map(async (u) => {
        try {
          return (await fetch(u)).ok;
        } catch (err) {
          return `${u}: ${err.message}`;
        }
      }),
    ));
    await bob.page.context().setOffline(false);
    check(offline.every((ok) => ok === true), `all ${total} data files kept, and served offline (${offline})`);
  }

  await pageInput(bob.page).fill('7');
  await pageInput(bob.page).press('Enter');
  await bob.page.waitForTimeout(400);
  const seven = await bob.page.locator('.pdf-reader .page[data-page-number="7"]').boundingBox();
  const main = await bob.page.locator('.pdf-reader-scroll').boundingBox();
  check(seven && Math.abs(seven.y - main.y) < 40, `jumped to page 7 (y ${seven?.y}, main ${main.y})`);

  const scaleOf = () => bob.page.locator('.pdf-reader .page[data-page-number="7"]').evaluate((p) => p.getBoundingClientRect().width);
  const width = await scaleOf();
  await bob.page.getByRole('button', { name: 'Zoom in' }).click();
  await bob.page.waitForTimeout(300);
  check(await scaleOf() > width * 1.1, 'Zoom in');
  await bob.page.getByRole('button', { name: 'Zoom out' }).click();
  await bob.page.locator('.pdf-reader-zoom-select').selectOption('page-fit');
  await bob.page.waitForTimeout(300);
  const fit = await bob.page.locator('.pdf-reader .page[data-page-number="7"]').boundingBox();
  check(fit.height <= main.height + 1, 'Fit page fits the page in');
  await bob.page.locator('.pdf-reader-zoom-select').selectOption('page-width');

  await bob.page.getByRole('button', { name: 'Contents', exact: true }).click();
  await shot(bob.page, '4-contents');
  await bob.page.locator('.pdf-reader-contents').getByRole('button', { name: 'Chapter 3' }).click();
  await bob.page.waitForFunction(() => document.querySelector('.pdf-reader-page-input')?.value === '3');
  check(true, 'Contents went to page 3');

  await bob.page.keyboard.press('Control+f');
  await bob.page.locator('.pdf-reader-find input').fill('quick brown');
  await bob.page.waitForFunction(() => /of 12$/.test(document.querySelector('.pdf-reader-find-status')?.textContent ?? ''), null, { timeout: 15000 });
  check(true, `Find: ${await bob.page.locator('.pdf-reader-find-status').textContent()}`);
  await bob.page.locator('.pdf-reader-find input').press('Enter');
  await bob.page.waitForTimeout(500);
  check(await bob.page.locator('.pdf-reader .textLayer .highlight').count() >= 1, 'matches highlighted');
  await shot(bob.page, '5-find');
  await bob.page.keyboard.press('Escape'); // closes Find only
  check(await reader(bob.page).isVisible(), 'Escape closed Find, not the PDF');

  // A place, then Back closes it, and it opens again there.
  await pageInput(bob.page).fill('9');
  await pageInput(bob.page).press('Enter');
  await bob.page.locator('.pdf-reader-scroll').evaluate((el) => { el.scrollTop += 200; });
  await bob.page.waitForTimeout(800);
  await bob.page.goBack();
  await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });
  check(bob.page.url().includes(`/dm/${alice.id}`), 'Back closed the PDF, still in the chat');
  await row.getByRole('button', { name: 'Open guide.pdf' }).click();
  await drawn(bob.page);
  await bob.page.waitForTimeout(500);
  check(await pageInput(bob.page).inputValue() === '9', 'reopened at page 9');
  await bob.page.keyboard.press('Escape');
  await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });

  // Themes.
  for (const theme of ['light', 'slack', 'halloween']) {
    await bob.page.evaluate((th) => localStorage.setItem('theme', th), theme);
    await bob.page.reload();
    await bob.page.waitForSelector('#dm-input');
    await row.locator('img.attachment-book-cover').waitFor({ timeout: 20000 });
    await shot(bob.page, `6-chat-${theme}`);
    await row.getByRole('button', { name: 'Open guide.pdf' }).click();
    await drawn(bob.page);
    await shot(bob.page, `6-reader-${theme}`);
    await bob.page.keyboard.press('Escape');
    await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });
  }
  await bob.page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await bob.page.reload();
  await bob.page.waitForSelector('#dm-input');

  // A locked PDF.
  await attach(alice.page, 'locked.pdf', lockedPdf);
  await alice.page.waitForTimeout(1500);
  check(await alice.page.locator('.attachment-tray img').count() === 0, 'locked: no preview in the tray');
  await send(alice.page, 'locked one');
  const lockedRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'locked one' });
  await lockedRow.getByRole('button', { name: 'Open locked.pdf' }).click({ timeout: 20000 });
  check(!/pages ·/.test(await lockedRow.locator('.attachment-file-size').textContent()), 'locked: no page count');
  await bob.page.getByLabel('Password').fill('nope');
  await bob.page.getByRole('button', { name: 'Open', exact: true }).click();
  await bob.page.getByRole('alert').filter({ hasText: "That password didn't open it." }).waitFor({ timeout: 10000 });
  await shot(bob.page, '7-password');
  await bob.page.getByLabel('Password').fill('secret');
  await bob.page.getByRole('button', { name: 'Open', exact: true }).click();
  await drawn(bob.page);
  check(await bob.page.locator('.pdf-reader-page-total').textContent() === 'of 2', 'locked: opens with the password');
  check(!(await bob.page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie)).includes('secret'), 'the password is not kept');
  await bob.page.keyboard.press('Escape');
  await reader(bob.page).waitFor({ state: 'detached', timeout: 5000 });

  // The hostile PDF.
  let dialogs = 0;
  bob.page.on('dialog', (d) => { dialogs += 1; d.dismiss(); });
  const popups = [];
  bob.page.context().on('page', (p) => popups.push(p.url()));
  await attach(alice.page, 'trap.pdf', Buffer.from(makeHostilePdf()));
  await alice.page.locator('.attachment-tray img').waitFor({ timeout: 20000 });
  await send(alice.page, 'open me');
  const trapRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'open me' });
  await trapRow.getByRole('button', { name: 'Open trap.pdf' }).click({ timeout: 20000 });
  await drawn(bob.page);
  await bob.page.waitForTimeout(1000);
  // PDF.js makes a plain web link of a script that only opens an address (app.launchURL) and of
  // a link to another site's PDF; nothing else in it (javascript:, Launch, a form submission, the
  // attached file) becomes a link. Clicked, a web link opens a new tab, as any link.
  const links = bob.page.locator('.pdf-reader .annotationLayer a');
  const targets = await links.evaluateAll((els) => els.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  check(targets.length >= 1 && targets.every((l) => /^https:\/\//.test(l.href) && l.target === '_blank' && /noopener/.test(l.rel)), 'only web links, opening a new tab, noopener');
  check(!targets.some((l) => /submit|calc|javascript|page\.html/i.test(l.href)), 'no link for Launch, a form submission, javascript: or the attached file');
  for (let i = 0; i < targets.length; i++) await links.nth(i).click({ force: true }).catch(() => {});
  // What has no link: clicked where it is on the page (its box), it does nothing.
  const pageBox = await bob.page.locator('.pdf-reader .page[data-page-number="1"]').boundingBox();
  const scale = pageBox.width / 595;
  for (const n of [1, 2, 4, 5, 6]) {
    await bob.page.mouse.click(pageBox.x + 150 * scale, pageBox.y + (842 - (712 - n * 40)) * scale);
  }
  await bob.page.waitForTimeout(1500);
  check(dialogs === 0, 'no dialogs');
  check(popups.length === targets.length, `only the clicked web links opened tabs (${popups.length} of ${targets.length})`);
  for (const p of bob.page.context().pages()) if (p !== bob.page) await p.close();
  check(bob.page.url().includes(`/dm/${alice.id}`), 'no navigation');
  check(await bob.page.locator('.pdf-reader .annotationLayer :is(input, textarea, select)').evaluateAll((els) => els.every((el) => el.disabled || el.readOnly)) , 'the field cannot be filled in');
  check(await bob.page.locator('.pdf-reader :is(iframe, object, embed, script)').count() === 0, 'no frames or scripts in the reader');
  await shot(bob.page, '8-trap');
  check(offsite.length === 0, `nothing asked of another site (${offsite.join(', ')})`);
  await bob.page.keyboard.press('Escape');

  // A guild channel, and a webhook's PDF.
  const guild = await api(alice.page, 'POST', '/guilds', { name: 'Docs' });
  const guildId = guild.id ?? guild.guild?.id;
  const invite = await api(alice.page, 'POST', `/guilds/${guildId}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  for (const user of [alice, bob]) {
    await user.page.goto(`${BASE}/guild/${guildId}`);
    await user.page.waitForSelector('#dm-input');
  }
  await attach(alice.page, 'guide.pdf', guidePdf());
  await alice.page.locator('.attachment-tray img').waitFor({ timeout: 20000 });
  await send(alice.page, 'in the guild');
  const guildRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'in the guild' });
  await guildRow.locator('img.attachment-book-cover').waitFor({ timeout: 20000 });
  check(/^12 pages · /.test(await guildRow.locator('.attachment-file-size').textContent()), 'guild: 12 pages');
  await guildRow.getByRole('button', { name: 'Open guide.pdf' }).click();
  await drawn(bob.page);
  check(true, 'a guild channel PDF opens');
  await bob.page.keyboard.press('Escape');

  const channelId = alice.page.url().split('/').pop();
  const hook = await api(alice.page, 'POST', `/channels/${channelId}/webhooks`, { name: 'Report Bot' });
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: 'weekly report' }));
  form.append('files[0]', new Blob([makePdf({ pages: 2 })], { type: 'application/pdf' }), 'weekly.pdf');
  const res = await fetch(`${BASE}/api/webhooks/${hook.id}/${hook.token}`, { method: 'POST', body: form });
  check(res.status === 204, `webhook posted a PDF (${res.status})`);
  const hookRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'weekly report' });
  await hookRow.getByRole('button', { name: 'Open weekly.pdf' }).click({ timeout: 15000 });
  await drawn(bob.page);
  check(await bob.page.locator('.pdf-reader-page-total').textContent() === 'of 2', "a webhook's PDF opens");
  await bob.page.keyboard.press('Escape');

  // A phone.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  watch(phone.page);
  await api(phone.page, 'POST', `/invites/${invite.code}`);
  await phone.page.goto(`${BASE}/guild/${guildId}/${channelId}`);
  const phoneRow = phone.page.locator('.each-dm-message-wrapper', { hasText: 'in the guild' });
  await phoneRow.locator('img.attachment-book-cover').waitFor({ timeout: 20000 });
  await shot(phone.page, '9-phone-chat');
  await phoneRow.getByRole('button', { name: 'Open guide.pdf' }).tap();
  await drawn(phone.page);
  await phone.page.waitForTimeout(500);
  const fits = await phone.page.evaluate(() => {
    const scroll = document.querySelector('.pdf-reader-scroll');
    return scroll.scrollWidth <= scroll.clientWidth + 1 && document.querySelector('.pdf-reader-toolbar').scrollWidth <= window.innerWidth;
  });
  check(fits, 'phone: fits the width, toolbar too');
  await shot(phone.page, '9-phone-reader');
  // A pinch: two fingers moving apart, through the DevTools protocol.
  const cdp = await phone.page.context().newCDPSession(phone.page);
  const before1 = await phone.page.locator('.pdf-reader .page').first().evaluate((p) => p.getBoundingClientRect().width);
  const touch = (type, spread) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: 200 - spread, y: 500, id: 1 }, { x: 200 + spread, y: 500, id: 2 }],
  });
  await touch('touchStart', 30);
  for (let s = 35; s <= 150; s += 5) await touch('touchMove', s);
  await touch('touchEnd', 0);
  await phone.page.waitForTimeout(800);
  const after1 = await phone.page.locator('.pdf-reader .page').first().evaluate((p) => p.getBoundingClientRect().width);
  check(after1 > before1 * 1.3, `phone: pinch zooms (${Math.round(before1)} -> ${Math.round(after1)})`);
  await shot(phone.page, '9-phone-pinched');
  await phone.page.goBack();
  await reader(phone.page).waitFor({ state: 'detached', timeout: 5000 });
  check(true, 'phone: Back closes it');

  check(csp.length === 0, `nothing refused by the Content-Security-Policy (${csp.join(' | ')})`);
  console.log('all good');
} finally {
  await browser.close();
}
