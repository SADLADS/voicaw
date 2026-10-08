// Edit Profile on a phone: the settings column is on top of the page, so opening Edit Profile
// (the card, a direct visit, the card again after another section) scrolls down to the form.
// A computer doesn't scroll (the column is beside the rail).
//   node e2e/serve.mjs &   then   node e2e/profilescroll.mjs [dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome();

// The form's top is on screen (allowing for the header), and the page has been scrolled.
async function formInView(page) {
  await page.waitForTimeout(800); // smooth scrolling
  return page.evaluate(() => {
    const top = document.querySelector('.edit-profile')?.getBoundingClientRect().top;
    return top !== undefined && top >= 0 && top < window.innerHeight / 2;
  });
}

try {
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  const { page } = phone;
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('.settings-profile-link');
  const before = await page.evaluate(() => document.querySelector('.edit-profile') === null);
  await page.tap('.settings-profile-link');
  await page.waitForSelector('.edit-profile');
  if (!before || !(await formInView(page))) throw new Error('card tap: form not scrolled into view');
  if (dir) await page.screenshot({ path: `${dir}/profilescroll-phone.png` });

  // Another section (back to /settings#...), then the card again.
  await page.tap('.settings-nav-item >> nth=0');
  await page.waitForSelector('.edit-profile', { state: 'detached' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.tap('.settings-profile-link');
  await page.waitForSelector('.edit-profile');
  if (!(await formInView(page))) throw new Error('second card tap: form not scrolled into view');

  // Straight to the page (e.g. from the user menu).
  await page.goto(`${BASE}/settings/profile`);
  await page.waitForSelector('.edit-profile');
  if (!(await formInView(page))) throw new Error('direct visit: form not scrolled into view');

  // A computer: the form is at the top of the content anyway, nothing scrolled.
  const desk = await signUp(browser, 'desk');
  await desk.page.goto(`${BASE}/settings`);
  await desk.page.click('.settings-profile-link');
  await desk.page.waitForSelector('.edit-profile');
  await desk.page.waitForTimeout(800);
  const deskScroll = await desk.page.evaluate(() => document.scrollingElement.scrollTop);
  if (deskScroll !== 0) throw new Error(`desktop page scrolled (${deskScroll})`);
  if (dir) await desk.page.screenshot({ path: `${dir}/profilescroll-desktop.png` });

  console.log('profilescroll: ok (phone scrolls to the form: card, card again, direct visit; desktop untouched)');
} catch (err) {
  console.error('profilescroll: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
