// Settings → Admin → Storage: the throwaway object store isn't MinIO, so the real API says the
// figures are unavailable; then the API's answer is replaced with MinIO-like figures to check
// the bar, the key and the list (widths match the shares, nearly full turns red, Refresh asks
// afresh), a non-admin is refused, light, dark and a phone.
//   node e2e/serve.mjs &   then   node e2e/storage.mjs [screenshot dir]
import fs from 'node:fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) fs.mkdirSync(dir, { recursive: true });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const API = `http://localhost:${process.env.E2E_API_PORT || 3099}`;
const GB = 1024 ** 3;
const figures = (over = {}) => ({
  available: true,
  total: 916 * GB,
  free: 692 * GB,
  buckets: [
    { name: 'uploads', bytes: 61.4 * GB, objects: 18234 },
    { name: 'profile-pics', bytes: 182 * 1024 ** 2, objects: 412 },
    { name: 'guild-icons', bytes: 9 * 1024 ** 2, objects: 37 },
    { name: 'emojis', bytes: 31 * 1024 ** 2, objects: 950 },
  ],
  otherBuckets: { bytes: 12 * GB, objects: 3100 },
  checkedAt: Date.now(),
  ...over,
});

// Answers /api/admin/storage with `body` from now on; returns the URLs asked.
async function fakeStore(page, body) {
  const asked = [];
  await page.unroute('**/api/admin/storage**');
  await page.route('**/api/admin/storage**', (route) => {
    asked.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(typeof body === 'function' ? body() : body) });
  });
  return asked;
}

const section = (page) => page.locator('.admin-storage');

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const { page } = admin;
  page.on('pageerror', (e) => console.log('page error:', e.message));

  // The real API: the stand-in store has no metrics.
  await page.goto(`${BASE}/settings`);
  await section(page).waitFor();
  await page.waitForSelector('.admin-storage >> text=doesn\'t say how much space');
  check(true, "the real API with a store that isn't MinIO: unavailable");
  check(await section(page).locator('.admin-storage-bar').count() === 0, 'no bar then');
  check(await section(page).locator('text=Checked').count() === 1, 'when it was checked');

  // Non-admins are refused.
  const bob = await signUp(browser, 'bob');
  const token = await bob.page.evaluate(() => localStorage.getItem('token'));
  const refused = (await bob.page.request.get(`${API}/api/admin/storage`, { headers: { Authorization: `Bearer ${token}` } })).status();
  check(refused === 403, `a non-admin gets 403 (${refused})`);

  // MinIO-like figures.
  let free = 692 * GB;
  const asked = await fakeStore(page, () => figures({ free }));
  await page.reload();
  await page.waitForSelector('.admin-storage-free');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await section(page).scrollIntoViewIfNeeded();
  check((await page.textContent('.admin-storage-free')).trim() === '692 GB free of 916 GB (76%)', 'free of total');
  const widths = await page.evaluate(() => {
    const bar = document.querySelector('.admin-storage-bar').getBoundingClientRect().width;
    const w = (sel) => document.querySelector(`.admin-storage-bar ${sel}`).getBoundingClientRect().width / bar;
    return { ours: w('.admin-storage-ours'), other: w('.admin-storage-other') };
  });
  const ours = (61.4 * GB + 222 * 1024 ** 2) / (916 * GB);
  const other = (916 - 692) / 916 - ours;
  check(Math.abs(widths.ours - ours) < 0.01 && Math.abs(widths.other - other) < 0.01,
    `bar shares: Voicaw ${(widths.ours * 100).toFixed(1)}%, other ${(widths.other * 100).toFixed(1)}%`);
  const rows = await section(page).locator('.admin-list li').allTextContents();
  check(rows[0] === 'Attachments61 GB · 18234 files', `attachments row (${rows[0]})`);
  check(rows.some((r) => r.startsWith('Other buckets on the store12 GB')), 'other buckets row');
  check(rows.some((r) => r.startsWith('Everything else on the drive')), 'everything else on the drive row');
  check(!(await page.locator('.admin-storage-free').evaluate((el) => el.classList.contains('low'))), 'not red at 76% free');
  if (dir) await section(page).screenshot({ path: `${dir}/storage-light.png` });

  // Nearly full, after Refresh.
  free = 40 * GB;
  await section(page).locator('button', { hasText: 'Refresh' }).click();
  await page.waitForSelector('.admin-storage-free.low');
  check(asked.at(-1).endsWith('/api/admin/storage?fresh=1'), 'Refresh asks afresh');
  if (dir) await section(page).screenshot({ path: `${dir}/storage-light-low.png` });
  const red = await page.locator('.admin-storage-free').evaluate((el) => getComputedStyle(el).color);
  check(red !== await page.locator('.admin-storage .admin-list li span').first().evaluate((el) => getComputedStyle(el).color), `red when under 10% free (${red})`);

  // Dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  if (dir) await section(page).screenshot({ path: `${dir}/storage-dark-low.png` });

  // Phone.
  const phone = await signUp(browser, 'admin', { ...devices['Pixel 7'] });
  free = 692 * GB;
  await fakeStore(phone.page, () => figures({ free }));
  await phone.page.goto(`${BASE}/settings`);
  const admTab = phone.page.locator('text=Admin').first();
  await admTab.waitFor();
  await phone.page.waitForTimeout(300);
  if (!(await section(phone.page).count())) await admTab.click();
  await section(phone.page).waitFor();
  await section(phone.page).scrollIntoViewIfNeeded();
  const fits = await phone.page.evaluate(() => {
    const el = document.querySelector('.admin-storage');
    const r = el.getBoundingClientRect();
    const overflow = [...el.querySelectorAll('*')].some((c) => c.getBoundingClientRect().right > window.innerWidth + 0.5);
    return { right: r.right, width: window.innerWidth, overflow, scroll: document.documentElement.scrollWidth > window.innerWidth };
  });
  check(!fits.overflow && fits.right <= fits.width && !fits.scroll, `fits the phone (${JSON.stringify(fits)})`);
  if (dir) await section(phone.page).screenshot({ path: `${dir}/storage-phone.png` });
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
