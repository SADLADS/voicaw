// Attachment types and the app's Content-Security-Policy (security audit, 2026-11-18): an SVG
// sent as an attachment (it could carry script) arrives as a plain file, not a picture; a PNG is
// still a picture that Open Image opens in a tab; and in a production build (where the CSP is)
// nothing the app does is refused by it, while a script-carrying SVG blob opened by hand doesn't
// run. Needs a production build (the dev server has no CSP), as offlinepwa.mjs:
//   E2E_WEB_PORT=5232 VITE_API_BASE_URL=/api/ VITE_WS_URL=ws://localhost:5232/ws \
//     npx vite build --config e2e/vite.config.mjs --outDir /tmp/<dir> --emptyOutDir
//   E2E_WEB_PORT=5232 npx vite preview --config e2e/vite.config.mjs --outDir /tmp/<dir> --port 5232 &
//   E2E_WEB_PORT=5232 node e2e/attachmenttypes.mjs [screenshot dir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

const EVIL = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.opener && (window.opener.pwned = true)</script><rect width="10" height="10"/></svg>';
const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#2a6' } }).png().toBuffer();

async function attach(page, name, mimeType, buffer) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles({ name, mimeType, buffer });
  await send(page, `here is ${name}`);
}

// Every refusal the CSP makes, per page.
function watchCsp(page, list) {
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) list.push(m.text()); });
}

const browser = await launchChrome();
const refused = [];
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  watchCsp(alice.page, refused);
  watchCsp(bob.page, refused);
  const policy = await bob.page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  if (!policy?.includes("script-src 'self'")) throw new Error(`no CSP in the page (${policy}); is this a production build?`);

  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await attach(alice.page, 'evil.svg', 'image/svg+xml', Buffer.from(EVIL));
  await attach(alice.page, 'green.png', 'image/png', png);

  // Bob: the SVG is a file to download, the PNG a picture.
  const svgRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'here is evil.svg' });
  await svgRow.locator('.attachment-file').waitFor({ timeout: 15000 });
  if (await svgRow.locator('img.attachment-media').count()) throw new Error('the SVG was shown as a picture');
  const pngRow = bob.page.locator('.each-dm-message-wrapper', { hasText: 'here is green.png' });
  const img = pngRow.locator('img.attachment-media');
  await img.waitFor({ timeout: 15000 });
  await bob.page.waitForFunction(() => [...document.querySelectorAll('img.attachment-media')].some((i) => i.complete && i.naturalWidth > 0));
  await shot(bob.page, '1-svg-file-png-picture');

  // Open Image still opens the decrypted PNG in a tab.
  await img.click({ button: 'right' });
  const [tab] = await Promise.all([
    bob.page.context().waitForEvent('page', { timeout: 10000 }),
    bob.page.click('text=Open Image'),
  ]);
  await tab.waitForLoadState();
  if (!tab.url().startsWith('blob:')) throw new Error(`Open Image opened ${tab.url()}`);
  await tab.close();

  // The CSP itself: an SVG with a script, opened by hand as a blob page, doesn't run it.
  const ran = await bob.page.evaluate(async (svg) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const w = window.open(url, '_blank');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    w?.close();
    return window.pwned === true;
  }, EVIL);
  if (ran) throw new Error('the CSP did not stop a script in an SVG blob page');
  const expected = refused.filter((r) => !/inline script/i.test(r)).length;
  // Only the hand-made blob page should have been refused.
  const unexpected = refused.filter((r) => !/blob:|inline/i.test(r));
  if (unexpected.length) throw new Error(`the CSP refused something the app does: ${unexpected.join(' | ')}`);
  console.log(`attachmenttypes: ok (SVG a file, PNG a picture and opens, CSP blocks a script page; ${expected} other refusals)`);
} catch (err) {
  console.error('attachmenttypes: FAILED', err.message.split('\n')[0]);
  if (refused.length) console.error('CSP refusals:', refused);
  process.exitCode = 1;
} finally {
  await browser.close();
}
