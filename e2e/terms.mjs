// Terms of use: registering needs the tick (the form won't send without it, the server refuses
// without it), and someone who hasn't accepted the current terms (here: /api/profile made to say
// so) sees only the terms screen until they agree (or log out), on a phone too.
//   node e2e/serve.mjs &   then   node e2e/terms.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const browser = await launchChrome();
try {
  // The form: no tick, no sign-up.
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.fill('input[placeholder="New Username"]', `noterms${String(Date.now()).slice(-5)}`);
  await page.fill('input[placeholder="New Password"]', 'correct horse battery staple');
  check(await page.isVisible('label:has-text("I agree to the") a[href="https://voicaw.com/terms/"]'), 'the tick links the terms');
  await shot(page, 'register-phone');
  const sent = [];
  page.on('request', (r) => { if (r.url().includes('/api/finaliseregister')) sent.push(r); });
  await page.click('button:has-text("Register")');
  await page.waitForTimeout(1000);
  check(sent.length === 0 && !(await page.isVisible('[aria-label="Recovery code"]')), 'without the tick nothing is sent');
  const refused = await page.evaluate(async () => (await fetch('/api/finaliseregister', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).status);
  check(refused === 400, 'and the server refuses a sign-up without it');
  await context.close();

  // Someone who hasn't accepted the current terms.
  const alice = await signUp(browser, 'alice', { ...devices['Pixel 7'] });
  const a = alice.page;
  let accepted = false;
  await a.route('**/api/profile', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, termsAccepted: accepted } });
  });
  a.on('request', (r) => { if (r.url().includes('/api/terms/accept')) accepted = true; });
  await a.reload();
  await a.waitForSelector('h3:has-text("Terms of use")');
  check(!(await a.$('#dm-main')), 'only the terms show, not the app');
  await shot(a, 'gate-phone');
  const go = a.locator('button:has-text("Agree and continue")');
  check(await go.isDisabled(), 'Agree waits for the tick');
  await a.check('label:has-text("I agree to the terms of use") input');
  await go.click();
  await a.waitForSelector('#dm-main', { timeout: 15000 });
  check(true, 'agreeing opens the app');
  await a.reload();
  await a.waitForSelector('#dm-main', { timeout: 15000 });
  check(!(await a.$('h3:has-text("Terms of use")')), 'not asked again');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'OK');
process.exit(failures ? 1 : 0);
