// Admin alerts (server/adminAlerts.js): a tester request and a report arrive while an admin has
// the app open: the Settings gear gets a count, live; Settings shows it beside Admin and Reports
// (and their subsections); marking the request added and dismissing the report clear it. A
// non-admin's gear never has one. Then the gear on a phone.
//   node e2e/serve.mjs &   then   node e2e/adminalerts.mjs [dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// A call to the API as the page's user.
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, { method, path, body });

const pip = (page) => page.$eval('.user-panel-settings', (a) => ({
  count: a.querySelector('.user-panel-alerts')?.textContent ?? null,
  label: a.getAttribute('aria-label'),
}));

async function expectPip(page, count) {
  await page.waitForFunction((want) => (document.querySelector('.user-panel-alerts')?.textContent ?? null) === want, count, { timeout: 10000 });
}

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const ann = await signUp(browser, 'ann');
  if ((await pip(admin.page)).count !== null) throw new Error('pip with nothing waiting');

  // A tester request from voicaw.com's form (no account), then a report: live, no reload.
  const email = `pal${Date.now()}@example.com`;
  if ((await call(ann.page, 'POST', '/tester-requests', { email })).status !== 201) throw new Error('tester request refused');
  await expectPip(admin.page, '1');
  const report = await call(ann.page, 'POST', '/reports', { kind: 'user', userId: admin.id, category: 'spam' });
  if (report.status !== 201) throw new Error(`report refused: ${report.status}`);
  await expectPip(admin.page, '2');
  const { label } = await pip(admin.page);
  if (label !== 'Settings (2 waiting for you)') throw new Error(`label: ${label}`);
  if ((await pip(ann.page)).count !== null) throw new Error('non-admin has a pip');
  await shot(admin.page, 'gear');

  // It survives a reload (loaded from GET /admin/alerts).
  await admin.page.reload();
  await admin.page.waitForSelector('#dm-main');
  await expectPip(admin.page, '2');

  // Settings: counts beside Admin (and Sign-ups under it) and Reports.
  await admin.page.click('.user-panel-settings');
  await admin.page.click('.settings-nav-item:has-text("Admin")');
  await admin.page.waitForSelector('.settings-nav-item:has-text("Admin") .settings-nav-alerts:text("1")');
  await admin.page.waitForSelector('.settings-nav-item:has-text("Reports") .settings-nav-alerts:text("1")');
  await admin.page.waitForSelector('.settings-nav-sub:has-text("Sign-ups") .settings-nav-alerts:text("1")');
  await shot(admin.page, 'settings-admin');

  // Dealing with them clears the counts.
  await admin.page.click(`.admin-list li:has-text("${email}") button:has-text("Mark added")`);
  await expectPip(admin.page, '1');
  if (await admin.page.$('.settings-nav-item:has-text("Admin") .settings-nav-alerts')) throw new Error('Admin still counted');
  await admin.page.click('.settings-nav-item:has-text("Reports")');
  await admin.page.click('button:has-text("Dismiss")');
  await expectPip(admin.page, null);
  if (await admin.page.$('.settings-nav-alerts')) throw new Error('a count is left in Settings');
  await shot(admin.page, 'cleared');

  // A phone: the gear in the user panel, with its count.
  const phone = await signUp(browser, 'adminphone', devices['Pixel 7']);
  await call(ann.page, 'POST', '/reports', { kind: 'user', userId: admin.id, category: 'other' });
  await expectPip(phone.page, '1');
  const box = await phone.page.$eval('.user-panel-alerts', (e) => {
    const r = e.getBoundingClientRect();
    return { right: r.right, width: window.innerWidth };
  });
  if (box.right > box.width) throw new Error('pip off screen on a phone');
  await shot(phone.page, 'phone');

  await admin.page.goto(`${BASE}/dm`);
  await admin.page.waitForSelector('.user-panel-alerts');
  await admin.page.emulateMedia({ colorScheme: 'dark' });
  await shot(admin.page, 'gear-dark');
  await admin.page.emulateMedia({ colorScheme: 'light' });
  await shot(admin.page, 'gear-light');
  console.log('admin alerts OK');
} finally {
  await browser.close();
}
