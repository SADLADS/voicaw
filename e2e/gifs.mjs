// GIFs: an admin sets the Klipy key in Settings → Admin, then the emoji picker's GIFs tab
// (trending, search, favourites) sends a GIF that shows for the other person (desktop and phone).
// Needs a real Klipy key (it searches Klipy for real):
//   node e2e/serve.mjs &   then   KLIPY_API_KEY=… node e2e/gifs.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const key = process.env.KLIPY_API_KEY;
if (!key) {
  console.error('gifs: set KLIPY_API_KEY');
  process.exit(1);
}

const browser = await launchChrome();
try {
  const admin = await signUp(browser, 'admin');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);

  // No key yet: no GIFs tab.
  await openChat(admin.page, bob.id);
  await admin.page.click('button[aria-label="Emoji"]');
  await admin.page.waitForSelector('.emoji-picker');
  if (await admin.page.$('role=tab[name="GIFs"]')) throw new Error('GIFs tab without a key');
  await admin.page.keyboard.press('Escape');

  // Settings → Admin.
  await admin.page.goto(`${BASE}/settings`);
  await admin.page.waitForSelector('text=Klipy API key');
  if (await bob.page.goto(`${BASE}/settings`).then(() => bob.page.waitForSelector('text=Klipy API key', { timeout: 3000 }).then(() => true, () => false))) {
    throw new Error('a non-admin sees the admin panel');
  }
  await admin.page.fill('#admin-klipyApiKey', key);
  await admin.page.click('.admin-setting button:has-text("Save")');
  await admin.page.waitForSelector(`text=Set here: …${key.slice(-4)}`);
  if ((await admin.page.inputValue('#admin-klipyApiKey')) !== '') throw new Error('key left in the box');
  await shot(admin.page, 'admin-panel');

  // The app reads the setting when it loads.
  await openChat(admin.page, bob.id);
  await admin.page.click('button[aria-label="Emoji"]');
  await admin.page.click('role=tab[name="GIFs"]');
  await admin.page.waitForSelector('.gif-tile img', { timeout: 15000 });
  await admin.page.waitForTimeout(1000);
  await shot(admin.page, 'trending');

  // Search, favourite the first result, see it under Favourites.
  await admin.page.fill('input[aria-label="Search GIFs"]', 'cat');
  await admin.page.waitForFunction(() => document.querySelector('.gif-tile-pick')?.getAttribute('aria-label')?.match(/cat|kitt/i), null, { timeout: 15000 });
  await admin.page.waitForTimeout(800);
  await shot(admin.page, 'search');
  const first = admin.page.locator('.gif-tile').first();
  await first.hover();
  await first.locator('button[aria-label="Add to favourites"]').click();
  await admin.page.fill('input[aria-label="Search GIFs"]', '');
  await admin.page.click('role=tab[name="Favourites (1)"]');
  await admin.page.waitForSelector('.gif-tile');
  await shot(admin.page, 'favourites');

  // Pick it: sent as its own message; the picker closes.
  await admin.page.click('.gif-tile-pick');
  await admin.page.waitForSelector('.emoji-picker', { state: 'detached' });
  await admin.page.waitForSelector('.dm-message-content img.attachment-media[src*="static.klipy.com"]', { timeout: 10000 });

  // Bob (phone) sees it, sized before it loads.
  await openChat(bob.page, admin.id);
  const img = await bob.page.waitForSelector('img.attachment-media[src*="static.klipy.com"]', { timeout: 10000 });
  await bob.page.waitForFunction((el) => el.complete && el.naturalWidth > 0, img, { timeout: 15000 });
  const box = await img.boundingBox();
  if (!box || box.width < 100) throw new Error(`GIF too small: ${JSON.stringify(box)}`);
  await shot(bob.page, 'phone-message');

  // Favourites follow you: Bob's phone picker (docked), GIFs tab, still none of his own.
  await bob.page.click('button[aria-label="Emoji"]');
  await bob.page.click('role=tab[name="GIFs"]');
  await bob.page.waitForSelector('.gif-tile img', { timeout: 15000 });
  await bob.page.waitForTimeout(800);
  await shot(bob.page, 'phone-picker');
  await bob.page.click('role=tab[name="Favourites"]');
  await bob.page.waitForSelector('text=No favourites yet');
  console.log('gifs: ok');
} catch (err) {
  console.error('gifs: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
