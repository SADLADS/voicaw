// The picture cropper in a real browser: Settings → Edit Profile opens a picked picture in it
// (round hole, slider), the wheel zooms, dragging moves it (never past an edge), Apply previews
// the crop and Save stores that square (checked in the stored file); Guild Settings' icon: the
// cropper over the dialog, Escape closes only it, Apply stores the chosen square; a bot's
// picture in the Developer Portal; a webhook's picture (over Channel settings, Escape closes only
// the cropper, previewed until Save Changes, stored cropped); a phone pinches to zoom and the
// dialog fits.
//   node e2e/serve.mjs &   then   node e2e/avatarcrop.mjs [screenshot dir]
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

// 400×200: the left half red, the right half blue, a yellow block near the top right.
const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const yellow = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#ffff00' } }).png().toBuffer();
const PICTURE = {
  name: 'halves.png',
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }, { input: yellow, left: 320, top: 20 }]).png().toBuffer(),
};

// The colour name at (x, y) of a stored picture, as fractions of its size.
async function colourAt(url, x, y) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't fetch ${url}: ${res.status}`);
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels;
  const [r, g, b] = [data[i], data[i + 1], data[i + 2]].map((v) => v > 128);
  return { width: info.width, colour: ({ '100': 'red', '001': 'blue', '110': 'yellow' })[`${+r}${+g}${+b}`] ?? `${data[i]},${data[i + 1]},${data[i + 2]}` };
}

const zoomValue = (page) => page.$eval('.image-cropper input[type="range"]', (el) => Number(el.value));
const imageBox = (page) => page.$eval('.image-cropper-frame img', (el) => el.getBoundingClientRect().toJSON());
const frameBox = (page) => page.$eval('.image-cropper-frame', (el) => el.getBoundingClientRect().toJSON());

// Drags the picture by (dx, dy) px with the mouse.
async function drag(page, dx, dy) {
  const f = await frameBox(page);
  const x = f.x + f.width / 2;
  const y = f.y + f.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;

  // ---- Edit Profile ----
  await a.goto(`${BASE}/settings/profile`);
  await a.setInputFiles('input[aria-label="Choose a profile picture"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  const f = await frameBox(a);
  let img = await imageBox(a);
  check(Math.abs(img.height - f.height) < 1 && Math.abs(img.width - 2 * f.width) < 1 && Math.abs(img.x - (f.x - f.width / 2)) < 1,
    'the picture opens with its middle square filling the frame');
  await shot(a, 'profile-cropper');

  // The wheel zooms (and the page doesn't scroll), the slider follows.
  await a.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await a.mouse.wheel(0, -300);
  await a.waitForFunction(() => Number(document.querySelector('.image-cropper input[type="range"]').value) > 1.5);
  check(await zoomValue(a) > 1.5, `the wheel zooms in (zoom ${(await zoomValue(a)).toFixed(2)})`);
  await shot(a, 'profile-zoomed');
  // Back out with the slider; dragging far left stops at the picture's right edge.
  await a.$eval('.image-cropper input[type="range"]', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await drag(a, -500, 0);
  img = await imageBox(a);
  check(Math.abs(img.x + img.width - (f.x + f.width)) < 1, 'dragging stops at the picture\'s edge (no gap)');
  await shot(a, 'profile-dragged');
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  const preview = await a.$eval('.edit-profile-picture img', (el) => el.src);
  check(preview.startsWith('blob:'), 'Apply previews the cropped picture');
  await shot(a, 'profile-preview');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('text=Profile saved.');
  const avatarUrl = await a.$eval('.edit-profile-picture img', (el) => el.src);
  const middle = await colourAt(avatarUrl, 0.5, 0.5);
  const corner = await colourAt(avatarUrl, 0.75, 0.25);
  check(middle.colour === 'blue' && corner.colour === 'yellow' && middle.width === 200,
    `the stored picture is the right-hand square (${middle.colour}, ${corner.colour}, ${middle.width}px)`);

  // ---- Guild icon ----
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Crop Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const guildId = Number(new URL(a.url()).pathname.split('/')[2]);
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Guild Settings")');
  await a.waitForSelector('.guild-settings-icon');
  await a.setInputFiles('.guild-settings-overview input[type="file"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await shot(a, 'guild-cropper');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  check(await a.$('.guild-settings-icon') !== null, 'Escape closes the cropper, not Guild Settings under it');
  await a.setInputFiles('.guild-settings-overview input[type="file"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await drag(a, 500, 0);
  // Arrow keys work on the focused frame too (already at the left edge: nothing moves).
  await a.keyboard.press('ArrowLeft');
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('text=Icon updated');
  const iconUrl = await a.$eval('.guild-settings-icon img', (el) => el.src);
  check(iconUrl.includes(`/guild-icons/${guildId}?v=1`), 'the icon was uploaded');
  const icon = await colourAt(iconUrl, 0.5, 0.5);
  check(icon.colour === 'red' && icon.width === 200, `the stored icon is the left-hand square (${icon.colour}, ${icon.width}px)`);
  await a.keyboard.press('Escape');

  // ---- A bot's picture ----
  await a.goto(`${BASE}/developers`);
  await a.click('button:has-text("New Application")');
  await a.fill('#dev-new-app-name', 'Crop Bot');
  await a.click('.vc-dialog button:has-text("Create")');
  await a.waitForSelector('#dev-bot-token');
  await a.click('[role="tab"]:has-text("General Information")');
  await a.setInputFiles('.dev-picture input[type="file"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await drag(a, -500, 0);
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  await a.waitForFunction(() => document.querySelector('.dev-picture-preview')?.src?.includes('/profile-pics/'));
  const botUrl = await a.$eval('.dev-picture-preview', (el) => el.src);
  const bot = await colourAt(botUrl, 0.75, 0.25);
  check(bot.colour === 'yellow', `the bot's picture is the right-hand square (${bot.colour})`);
  await shot(a, 'bot-picture');

  // ---- A webhook's picture ----
  await a.goto(`${BASE}/guild/${guildId}`);
  await a.waitForSelector('.guild-channel:has-text("general")');
  await a.click('button[aria-label="Edit general"]');
  await a.click('[role="tab"]:has-text("Webhooks")');
  await a.click('button:has-text("New Webhook")');
  await a.waitForSelector('input[aria-label="Webhook name"]');
  await a.setInputFiles('input[aria-label="Webhook picture"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  check(await a.$('input[aria-label="Webhook name"]') !== null, 'Escape closes the cropper, not Channel settings under it');
  check(await a.$('button:has-text("Save Changes")') === null, 'a cancelled crop changes nothing');
  await a.setInputFiles('input[aria-label="Webhook picture"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await shot(a, 'webhook-cropper');
  await drag(a, -500, 0);
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  const hookPreview = await a.$eval('.webhook-avatar.large', (el) => el.src);
  check(hookPreview.startsWith('blob:'), 'Apply previews the cropped webhook picture');
  await shot(a, 'webhook-preview');
  await a.click('button:has-text("Save Changes")');
  await a.waitForFunction(() => document.querySelector('.webhook-summary .webhook-avatar')?.src.includes('/profile-pics/webhooks/'));
  const hookUrl = await a.$eval('.webhook-summary .webhook-avatar', (el) => el.src);
  const hookMiddle = await colourAt(hookUrl, 0.5, 0.5);
  const hookCorner = await colourAt(hookUrl, 0.75, 0.25);
  check(hookMiddle.colour === 'blue' && hookCorner.colour === 'yellow',
    `the webhook's stored picture is the right-hand square (${hookMiddle.colour}, ${hookCorner.colour})`);
  await shot(a, 'webhook-picture');
  await a.keyboard.press('Escape');

  // ---- Phone: pinch to zoom ----
  const phone = await signUp(browser, 'pinch', { ...devices['Pixel 7'] });
  const p = phone.page;
  await p.goto(`${BASE}/settings/profile`);
  await p.setInputFiles('input[aria-label="Choose a profile picture"]', PICTURE);
  await p.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  const dialog = await p.$eval('.image-cropper', (el) => el.getBoundingClientRect().toJSON());
  const viewport = p.viewportSize();
  check(dialog.x >= 0 && dialog.x + dialog.width <= viewport.width, 'the dialog fits the phone');
  await shot(p, 'phone-cropper');
  const pf = await frameBox(p);
  const cx = pf.x + pf.width / 2;
  const cy = pf.y + pf.height / 2;
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, gap) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: cx - gap, y: cy, id: 1 }, { x: cx + gap, y: cy, id: 2 }],
  });
  await touch('touchStart', 20);
  for (let gap = 25; gap <= 100; gap += 5) await touch('touchMove', gap);
  await touch('touchEnd', 0);
  const pinched = await zoomValue(p);
  check(pinched > 3, `pinching apart zooms in (zoom ${pinched.toFixed(2)})`);
  await shot(p, 'phone-pinched');
  await p.click('.image-cropper button:has-text("Apply")');
  await p.waitForSelector('.image-cropper', { state: 'detached' });

  console.log('avatarcrop: ok');
} catch (err) {
  console.error('avatarcrop: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
