// Safety numbers: Settings → Privacy's "Show safety numbers in DMs" is off by default (no badge in
// a DM); turned on (kept after a reload), the DM shows Not verified, which opens the safety
// number; both people see the same one (Bob on a phone); Mark as verified makes it ✓ Verified;
// turned off again, the badge is gone.
//   node e2e/serve.mjs &   then   node e2e/safetynumbers.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const LABEL = 'Show safety numbers in DMs';

async function setSafetyNumbers(page, on) {
  await page.goto(`${BASE}/settings/privacy`);
  const toggle = page.getByLabel(LABEL);
  await toggle.scrollIntoViewIfNeeded();
  await toggle.setChecked(on);
  return toggle;
}

async function readNumber(page) {
  await page.click('.key-status-badge');
  const box = page.locator('.safety-number');
  await page.waitForFunction(() => /^(\d{5} ){11}\d{5}$/.test(
    [...document.querySelectorAll('.safety-number span')].map((s) => s.textContent).join(' ')
  ), null, { timeout: 10000 });
  return (await box.locator('span').allTextContents()).join(' ');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;

  // Off by default: no badge.
  await openChat(a, bob.id);
  await a.waitForTimeout(1000);
  if (await a.locator('.key-status-badge').count()) throw new Error('the badge shows with the setting off');
  await a.goto(`${BASE}/settings/privacy`);
  if (await a.getByLabel(LABEL).isChecked()) throw new Error('Show safety numbers should be off by default');
  console.log('off by default: no badge, switch unticked');

  // On, kept after a reload.
  const toggle = await setSafetyNumbers(a, true);
  await shot(a, 'settings-privacy');
  await a.reload();
  if (!(await toggle.isChecked())) throw new Error('the setting was not kept after a reload');
  console.log('turned on, kept after a reload');

  await openChat(a, bob.id);
  await a.waitForSelector('.key-status-badge:has-text("Not verified")', { timeout: 10000 });
  await shot(a, 'dm-badge');
  const aliceNumber = await readNumber(a);
  await shot(a, 'dialog');
  console.log('badge opens the safety number:', aliceNumber.slice(0, 11), '…');

  // Bob (phone) sees the same number.
  await setSafetyNumbers(b, true);
  await openChat(b, alice.id);
  await b.waitForSelector('.key-status-badge', { timeout: 10000 });
  await shot(b, 'phone-badge');
  const bobNumber = await readNumber(b);
  await shot(b, 'phone-dialog');
  if (bobNumber !== aliceNumber) throw new Error(`the two sides' numbers differ:\n${aliceNumber}\n${bobNumber}`);
  const dialog = await b.locator('.safety-number').boundingBox();
  const width = b.viewportSize().width;
  if (dialog.x < 0 || dialog.x + dialog.width > width) throw new Error('the safety number is wider than the phone');
  console.log('both sides see the same number; fits the phone');

  // Mark as verified.
  await a.click('button:has-text("Mark as verified")');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.key-status-badge:has-text("Verified")', { timeout: 5000 });
  await a.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await shot(a, 'dm-verified');
  console.log('marked verified: ✓ Verified');

  // Off again: gone.
  await setSafetyNumbers(a, false);
  await openChat(a, bob.id);
  await a.waitForTimeout(1000);
  if (await a.locator('.key-status-badge').count()) throw new Error('the badge stayed with the setting off');
  console.log('turned off: badge gone');
  console.log('safetynumbers: ok');
} catch (err) {
  console.error('safetynumbers: FAILED', err.message.split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
