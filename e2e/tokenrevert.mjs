// The saved login going back to an expired, month-old token of the same account mid-run
// (seen on a Windows desktop app): the page must keep using its new login.
//   node e2e/serve.mjs &   then   node e2e/tokenrevert.mjs
import { createRequire } from 'module';
import { launchChrome, signUp, BASE } from './helpers.mjs';
const require = createRequire(new URL('../server/index.js', import.meta.url));
const jwt = require('jsonwebtoken');

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const a = ann.page;
  await a.waitForSelector('#dm-main', { timeout: 20000 });
  const fresh = await a.evaluate(() => localStorage.getItem('token'));
  const { id, username } = JSON.parse(Buffer.from(fresh.split('.')[1], 'base64url'));
  const iat = Math.floor(Date.now() / 1000) - 35 * 86400;
  const stale = jwt.sign({ id, username, sid: 'gone', iat, exp: iat + 30 * 86400 }, 'e2e-only-secret');
  const refused = [];
  a.on('response', (r) => { if (r.url().includes('/api/') && r.status() === 403 && !r.url().includes('/admin')) refused.push(r.url()); });
  const warnings = [];
  a.on('console', (m) => { if (m.text().includes('went back to an older')) warnings.push(m.text()); });
  await a.evaluate((t) => localStorage.setItem('token', t), stale);
  console.log('storage went back to an expired token of the same account');
  await a.click('text=Notes').catch(() => {});
  await a.waitForTimeout(1500);
  await a.click('text=Friends').catch(() => {});
  await a.waitForTimeout(2500);
  const now = await a.evaluate(() => localStorage.getItem('token'));
  console.log('403s:', refused.length, refused.slice(0, 3));
  console.log('saved login is the new one again:', now === fresh, '; warned:', warnings.length > 0);
  console.log('still in the app:', await a.isVisible('#dm-main'), '; login page:', await a.isVisible('input[placeholder="Username"]'));
  if (refused.length || now !== fresh || !(await a.isVisible('#dm-main'))) throw new Error('FAILED');
  console.log('OK');
} finally {
  await browser.close();
}
