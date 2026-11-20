// The saved login going back to an older one of the same account mid-run (seen on a Windows
// desktop app, as an expired month-old token): the page must keep using its new login. Since
// the login cookie (2026-11-20) the page keeps only what the login says (localStorage `login`);
// an old one put back would name a session that's gone (409 login_changed, or 403s).
//   node e2e/serve.mjs &   then   node e2e/tokenrevert.mjs
import { launchChrome, signUp } from './helpers.mjs';

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const a = ann.page;
  await a.waitForSelector('#dm-main', { timeout: 20000 });
  const fresh = await a.evaluate(() => localStorage.getItem('login'));
  const login = JSON.parse(fresh);
  if (!login?.sid || (await a.evaluate(() => localStorage.getItem('token')))) throw new Error('not logged in by cookie');
  const stale = JSON.stringify({ ...login, sid: 'gone', iat: login.iat - 35 * 86400 });
  const refused = [];
  a.on('response', (r) => { if (r.url().includes('/api/') && [403, 409].includes(r.status()) && !r.url().includes('/admin')) refused.push(`${r.status()} ${r.url()}`); });
  const warnings = [];
  a.on('console', (m) => { if (m.text().includes('went back to an older')) warnings.push(m.text()); });
  await a.evaluate((s) => localStorage.setItem('login', s), stale);
  console.log('storage went back to an older login of the same account');
  await a.click('text=Notes').catch(() => {});
  await a.waitForTimeout(1500);
  await a.click('text=Friends').catch(() => {});
  await a.waitForTimeout(2500);
  const now = await a.evaluate(() => localStorage.getItem('login'));
  console.log('refused:', refused.length, refused.slice(0, 3));
  console.log('saved login is the new one again:', JSON.parse(now).sid === login.sid, '; warned:', warnings.length > 0);
  console.log('still in the app:', await a.isVisible('#dm-main'), '; login page:', await a.isVisible('input[placeholder="Username"]'));
  if (refused.length || JSON.parse(now).sid !== login.sid || !(await a.isVisible('#dm-main'))) throw new Error('FAILED');
  console.log('OK');
} finally {
  await browser.close();
}
