// The Android app's closed test on Google Play: voicaw.com (built into a temporary folder and
// served by this script on E2E_SITE_PORT, 3106, with its /api/ going to the throwaway API, as
// nginx does) offers no APK; a phone visitor's first button leads to the form; an empty email is
// refused in the page; a request is thanked, and shows up live in an admin's Settings → Admin →
// Android testers, which marks it added (waiting ones first) and deletes it. Light and dark.
//   node e2e/serve.mjs &   then   node e2e/testers.mjs [screenshot dir]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../website/build.mjs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) fs.mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 3106);
const SITE = `http://localhost:${SITE_PORT}`;

const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-site-'));
await buildSite({ siteDir, releases: {} });

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.js': 'text/javascript' };
const site = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const body = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const answer = await fetch(`${API}${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? '' }, body: req.method === 'GET' ? undefined : body });
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'text/plain' });
    res.end(Buffer.from(await answer.arrayBuffer()));
    return;
  }
  const url = new URL(req.url, SITE).pathname;
  let file = path.join(siteDir, url.endsWith('/') ? `${url}index.html` : url);
  if (!file.startsWith(siteDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => site.listen(SITE_PORT, resolve));

const EMAIL = `pal${Date.now()}@gmail.com`;
const browser = await launchChrome();
try {
  // An admin with Settings open, to see the request arrive.
  const admin = await signUp(browser, 'admin');
  await admin.page.goto(`${BASE}/settings`);
  await admin.page.waitForSelector('text=Android testers');

  // A phone visitor.
  const phone = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark' });
  const page = await phone.newPage();
  page.on('pageerror', (e) => console.log('[site] page error:', e.message));
  await page.goto(`${SITE}/`);
  check(!(await page.content()).match(/\.apk|updates\.voicaw\.com\/android/), 'no APK anywhere on the page');
  const primary = page.locator('#primary-download');
  check((await primary.textContent()).includes('Get Voicaw for Android'), 'phones are offered Android first');
  await primary.click();
  await page.waitForFunction(() => location.hash === '#android-test');
  await page.waitForTimeout(800); // smooth scrolling
  check(await page.locator('#tester-form input[name="email"]').isVisible(), 'which leads to the form');
  check(await page.locator('#android-test a[href="https://play.google.com/store/apps/details?id=com.voicaw.app"]').count() === 1, 'with the Google Play link');
  const trap = await page.locator('#tester-form input[name="website"]').boundingBox();
  check(trap.x + trap.width <= 0, 'the bots\' field is off the screen');
  if (dir) await page.screenshot({ path: `${dir}/form-phone-dark.png`, fullPage: false });

  await page.click('#tester-form button');
  check((await page.textContent('#tester-status')).includes('Enter the email address'), 'an empty email is refused');
  await page.fill('#tester-form input[name="email"]', EMAIL.replace('pal', 'Pal'));
  await page.fill('#tester-form input[name="name"]', 'Pal');
  await page.fill('#tester-form textarea[name="note"]', 'Pixel 7, Android 15');
  await page.click('#tester-form button');
  await page.waitForSelector('.tester-done');
  check((await page.textContent('.tester-done')).includes(EMAIL.replace('pal', 'Pal')), 'thanked, naming the email');
  if (dir) await page.screenshot({ path: `${dir}/form-sent-phone-dark.png` });

  // Desktop, light: the Android card leads to the form too.
  const desk = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  const deskPage = await desk.newPage();
  await deskPage.goto(`${SITE}/#android-test`);
  check(await deskPage.locator('a.store[href="#android-test"]').count() === 1, 'the Android card leads to the form');
  if (dir) await deskPage.locator('#android-test').screenshot({ path: `${dir}/form-desktop-light.png` });

  // The admin sees it at once, marks it added and deletes it.
  const row = admin.page.locator(`.admin-list li:has-text("${EMAIL}")`);
  await row.waitFor();
  check((await row.textContent()).includes('Pixel 7, Android 15'), 'the admin sees the request live, in lower case, with its note');
  if (dir) await admin.page.locator('.admin-setting:has-text("Android testers")').screenshot({ path: `${dir}/admin-list.png` });
  await row.locator('button:has-text("Mark added")').click();
  await row.locator('button:has-text("Not added")').waitFor();
  check((await row.textContent()).includes('Added '), 'marked added');
  await row.locator('button:has-text("Delete")').click();
  await row.waitFor({ state: 'detached' });
  check(true, 'and deleted');

  console.log(failures ? `testers: ${failures} FAILED` : 'testers: ok');
  if (failures) process.exitCode = 1;
} catch (err) {
  console.error('testers: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
  fs.rmSync(siteDir, { recursive: true, force: true });
}
