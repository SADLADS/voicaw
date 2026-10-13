// Full profiles and banners. Alice edits her own (the user menu's Edit Profile): display name,
// banner picture through the 5:2 cropper, banner colour, custom status and about me, saved at once,
// her card showing the banner. Bob (a picture, a banner colour, playing "Hades" through a
// socket as the desktop app would) is opened from his card in a guild: banner, bigger picture
// (opens the image viewer), tabs About me / Activity (Hades, playing now) / Mutual friends
// (Carol, who opens in its place) / Mutual guilds (the guild, which goes there); hiding mutual
// friends in Settings → Privacy takes that tab away. Phone (Carol): the profile fits.
//   node e2e/serve.mjs &   then   node e2e/userprofile.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE, makeFriends } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

// 500×200: the left half red, the right half blue (a banner); a green square (a picture).
const red = await sharp({ create: { width: 250, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const BANNER = {
  name: 'banner.png',
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 500, height: 200, channels: 3, background: '#0000ff' } }).composite([{ input: red, left: 0, top: 0 }]).png().toBuffer(),
};
const GREEN = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#00aa00' } }).png().toBuffer();

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const [a, b, c] = [alice.page, bob.page, carol.page];
  await makeFriends(alice, bob, carol);
  const guild = await api(a, 'POST', '/guilds', { name: 'Profiles' });
  const general = guild.channels[0];
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
  await api(b, 'POST', `/invites/${invite.code}`);
  await api(c, 'POST', `/invites/${invite.code}`);

  // Bob: a picture, a banner colour, and Hades on a socket of his own (as the desktop app sends it).
  await b.evaluate(async (png) => {
    const auth = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
    const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
    const start = await (await fetch('/api/profile/avatar', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'image/png', size: bytes.length }) })).json();
    await fetch(start.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
    await fetch(`/api/profile/avatar/${start.uploadId}/ready`, { method: 'POST', headers: auth, body: '{}' });
    await fetch('/api/profile', { method: 'PUT', headers: auth, body: JSON.stringify({ bannerColor: 0x2e8b57, bio: 'Hello from Bob' }) });
  }, GREEN.toString('base64'));
  await b.evaluate(() => new Promise((resolve) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
    window.gameSocket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'presence', visible: true, idleIn: 600000 }));
      socket.send(JSON.stringify({ type: 'identify', token: localStorage.getItem('token') }));
      setTimeout(() => {
        socket.send(JSON.stringify({ type: 'activity', activities: [{ name: 'Hades', type: 0, start: Date.now() - 60000 }] }));
        resolve();
      }, 500);
    };
  }));

  // Alice: her own profile from the user menu's Edit Profile (her picture and name there too).
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.click('.user-panel-me');
  await a.click('.user-menu-item:has-text("Edit Profile")');
  const own = a.locator('.user-profile');
  await own.waitFor();
  check(await own.locator('button[aria-label="Change profile picture"]').count() === 1 && !(await a.$('.user-menu')), "the user menu's Edit Profile opens her own profile, with edit buttons");
  await own.locator('button[aria-label="Edit display name"]').click();
  await own.locator('input[aria-label="Display name"]').fill(`${alice.name} A`);
  await a.keyboard.press('Enter');
  await own.locator(`.user-profile-name:text-is("${alice.name} A")`).waitFor();
  check(await a.locator(`.member-row:has-text("${alice.name} A")`).count() === 1, 'her display name, edited there, shows in the member list');
  await a.setInputFiles('input[aria-label="Choose a banner image"]', BANNER);
  await a.waitForSelector('.image-cropper-wide .image-cropper-frame img[style*="left"]');
  const frame = await a.locator('.image-cropper-frame').boundingBox();
  check(Math.abs(frame.width / frame.height - 2.5) < 0.05, `the banner cropper is 5:2 (${Math.round(frame.width)}×${Math.round(frame.height)})`);
  await shot(a, 'banner-cropper');
  await a.click('.image-cropper button:has-text("Apply")');
  await own.locator('.user-profile-banner img').waitFor({ timeout: 20000 });
  check(true, 'the banner picture is saved and shown');
  await own.locator('input[aria-label="Banner colour"]').fill('#aa3366');
  await a.waitForFunction(async () => {
    const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await res.json()).banner_color === 0xaa3366;
  }, null, { timeout: 10000 });
  check(true, 'the banner colour is saved once it rests');
  await own.locator('button[aria-label="Edit status"]').click();
  await own.locator('input[aria-label="Custom status"]').fill('Testing profiles');
  await a.keyboard.press('Enter');
  await own.locator('.profile-card-custom-status:has-text("Testing profiles")').waitFor();
  await own.locator('button[aria-label="Edit about me"]').click();
  await own.locator('textarea[aria-label="About me"]').fill('I make e2e tests.');
  await own.locator('button:has-text("Save")').click();
  await own.locator('.profile-card-bio:has-text("I make e2e tests.")').waitFor();
  check(true, 'status and about me edited in place');
  await shot(a, 'own-profile');
  await a.keyboard.press('Escape');
  await own.waitFor({ state: 'detached' });
  // Her card (Escape closed it too) shows the banner.
  await a.locator(`.member-row:has-text("${alice.name}")`).click();
  await a.locator('.member-card .profile-card-banner img').waitFor();
  check(true, 'her card shows the banner');
  await a.keyboard.press('Escape');

  // Bob's profile, from his card.
  await a.locator(`.member-row:has-text("${bob.name}")`).click();
  await a.locator('.member-card .profile-card-name').click();
  const profile = a.locator('.user-profile');
  await profile.waitFor();
  const bannerColour = await profile.locator('.user-profile-banner').evaluate((el) => getComputedStyle(el).backgroundColor);
  check(bannerColour === 'rgb(46, 139, 87)', `his banner colour (${bannerColour})`);
  check(await profile.locator('.profile-card-bio:has-text("Hello from Bob")').count() === 1, 'his about me');
  const tabs = () => profile.locator('[role="tab"]').allTextContents();
  await a.waitForFunction(() => document.querySelectorAll('.user-profile [role="tab"]').length === 4);
  check(JSON.stringify(await tabs()) === '["About me","Activity","Mutual friends (1)","Mutual guilds (1)"]', `tabs: ${(await tabs()).join(', ')}`);
  const box = await profile.boundingBox();
  check(Math.round(box.width) === 600, `600 px wide (${Math.round(box.width)})`);
  await shot(a, 'bob-profile');

  await profile.locator('[role="tab"]:has-text("Activity")').click();
  await profile.locator('.user-profile-game:has-text("Hades")').waitFor();
  check(await profile.locator('.user-profile-game:has-text("Playing now")').count() === 1, 'Activity: Hades, playing now');
  await shot(a, 'bob-activity');
  await profile.locator('[role="tab"]:has-text("Mutual guilds")').click();
  check(await profile.locator('.user-profile-row:has-text("Profiles")').count() === 1, 'Mutual guilds: Profiles');
  await profile.locator('[role="tab"]:has-text("Mutual friends")').click();
  await profile.locator(`.user-profile-row:has-text("${carol.name}")`).click();
  await a.locator(`.user-profile[aria-label="Profile of ${carol.name}"]`).waitFor();
  check(true, "a mutual friend opens Carol's profile in its place");
  await a.keyboard.press('Escape');

  // The picture opens in the image viewer.
  await a.locator(`.member-row:has-text("${bob.name}")`).click();
  await a.locator('.member-card .profile-card-avatar').click();
  await profile.locator('button[aria-label="View profile picture"]').click();
  await a.waitForSelector('.image-viewer');
  check(true, 'his picture opens in the image viewer');
  await shot(a, 'picture-viewer');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.image-viewer', { state: 'detached' });
  check(await profile.count() === 1, 'Escape closes only the viewer');
  await a.keyboard.press('Escape');

  // Bob hides mutual friends: the tab goes.
  await api(b, 'PUT', '/preferences', { showMutualFriends: false });
  await a.locator(`.member-row:has-text("${bob.name}")`).click();
  await a.locator('.member-card .profile-card-avatar').click();
  await a.waitForFunction(() => document.querySelectorAll('.user-profile [role="tab"]').length === 3);
  check(!(await tabs()).some((tab) => tab.startsWith('Mutual friends')), `hidden: ${(await tabs()).join(', ')}`);
  await a.keyboard.press('Escape');

  // Phone: a tap on Alice in the member list opens her profile straight away, the whole screen
  // (as the emoji panel pulled up); a short swipe down springs back, a long one closes it.
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.click('button[aria-label="Show member list"]');
  await c.locator(`.member-row:has-text("${alice.name}")`).tap();
  const phone = c.locator('.user-profile.sheet');
  await phone.waitFor();
  const phoneBox = await phone.boundingBox();
  const viewport = c.viewportSize();
  check(Math.round(phoneBox.width) === viewport.width && Math.round(phoneBox.height) === viewport.height && !(await c.$('.member-card')), `phone: full screen, no card (${Math.round(phoneBox.width)}x${Math.round(phoneBox.height)})`);
  await shot(c, 'phone-profile');
  const cdp = await c.context().newCDPSession(c);
  const swipe = async (distance) => {
    const x = 200;
    const y = 300;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (distance * i) / 10 }] });
      await c.waitForTimeout(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await c.waitForTimeout(400);
  };
  await swipe(60);
  check(await phone.count() === 1 && Math.round((await phone.boundingBox()).y) === 0, 'a short slow swipe down springs back');
  await swipe(400);
  check(await phone.count() === 0, 'a long swipe down closes it');

  await b.evaluate(() => window.gameSocket.close());
  console.log('userprofile: all good');
} finally {
  await browser.close();
}
