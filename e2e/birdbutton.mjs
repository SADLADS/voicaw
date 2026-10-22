// The rail's bird is the DM button. It faces left in encrypted chats and turns round (a flip
// about its upright axis, smooth: sampled every frame, no jumps) to face right in a guild and
// back; a click from a guild opens the DMs, one while there goes nowhere; both pop the link
// (×1.12 and back) without cutting the flip short. An unread DM puts its sender's picture over
// the bird, and opening it brings the bird back. Reduced motion: no flip, just the change.
// Desktop and phone.
//   node e2e/serve.mjs &   then   node e2e/birdbutton.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => { if (dir) await page.screenshot({ path: `${dir}/${name}.png` }); };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const path = (page) => page.evaluate(() => location.pathname);
// cos of the bird's turn: 1 facing left, -1 facing right (perspective() leaves m11 alone).
const facing = (page) => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.rail-logo')).transform).m11);

// Records, every frame from now on for 1.2 s, the bird's turn and the link's scale, and every
// navigation.
const watch = (page) => page.evaluate(() => {
  window.__navs = [];
  window.__frames = [];
  if (!window.__navWatch) {
    window.__navWatch = true;
    navigation.addEventListener('navigate', (e) => window.__navs.push(new URL(e.destination.url).pathname));
  }
  const started = performance.now();
  const frame = () => {
    const logo = document.querySelector('.rail-logo');
    const link = document.querySelector('.rail-bird');
    if (logo && link) {
      window.__frames.push([
        performance.now() - started,
        new DOMMatrix(getComputedStyle(logo).transform).m11,
        new DOMMatrix(getComputedStyle(link).transform).a,
      ]);
    }
    if (performance.now() - started < 1200) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
const watched = async (page) => {
  await page.waitForTimeout(1300);
  return page.evaluate(() => ({ navs: window.__navs, frames: window.__frames }));
};

// The turn from `from` to `to` (±1): every frame between the two, no step bigger than a
// smooth turn makes, taking about the transition's 0.46 s.
function checkTurn(frames, from, to, label) {
  const cos = frames.map((f) => f[1]);
  check(Math.abs(cos[0] - from) < 0.02 && Math.abs(cos[cos.length - 1] - to) < 0.02,
    `${label}: from ${from} to ${to} (${cos[0].toFixed(2)} → ${cos[cos.length - 1].toFixed(2)})`);
  const moving = frames.filter((f) => Math.abs(f[1] - from) > 0.01 && Math.abs(f[1] - to) > 0.01);
  const steps = cos.slice(1).map((c, i) => Math.abs(c - cos[i]));
  const sign = Math.sign(to - from);
  const monotonic = cos.slice(1).every((c, i) => Math.sign(c - cos[i]) !== -sign || Math.abs(c - cos[i]) < 0.005);
  const span = moving.length ? moving[moving.length - 1][0] - moving[0][0] : 0;
  check(moving.length >= 8 && Math.max(...steps) < 0.45 && monotonic && span > 300 && span < 700,
    `${label}: turns smoothly (${moving.length} frames over ${Math.round(span)} ms, biggest step ${Math.max(...steps).toFixed(2)})`);
}
const peakScale = (frames) => Math.max(...frames.map((f) => f[2]));

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await makeFriends(alice, bob, carol);
  const one = await api(alice.page, 'POST', '/guilds', { name: 'One' });
  const invite = await api(alice.page, 'POST', `/guilds/${one.id}/invites`, {});
  await api(bob.page, 'POST', `/invites/${invite.code}`);
  await openChat(alice.page, bob.id);
  await send(alice.page, 'hello');
  await alice.page.waitForSelector('text=hello');

  const a = alice.page;
  const dmPath = await path(a);
  const bird = a.getByRole('link', { name: 'Direct Messages', exact: true });
  check(await bird.evaluate((el) => el.classList.contains('rail-bird') && Boolean(el.querySelector('.rail-logo'))), 'desktop: the DM button is the bird');
  check(await a.locator('.sidebar .nav-icon[aria-label="Direct Messages"]').count() === 0, 'desktop: no separate DM icon');
  check(await facing(a) > 0.99, 'desktop: faces left in a DM');
  await shot(a, 'desktop-dm');

  // To a guild: turns round to face right.
  await watch(a);
  await a.getByRole('link', { name: 'One', exact: true }).click();
  await a.waitForTimeout(230);
  await shot(a, 'desktop-midturn');
  let r = await watched(a);
  checkTurn(r.frames, 1, -1, 'desktop: to a guild');
  await shot(a, 'desktop-guild');

  // The bird from a guild: opens the DMs, turning back, and pops without spoiling the turn.
  await watch(a);
  await bird.click();
  r = await watched(a);
  check(r.navs.length === 1 && (await path(a)).startsWith('/dm'), `desktop: the bird opens the DMs (${JSON.stringify(r.navs)})`);
  checkTurn(r.frames, -1, 1, 'desktop: back to DMs');
  check(peakScale(r.frames) > 1.08 && peakScale(r.frames) <= 1.121 && r.frames[r.frames.length - 1][2] === 1,
    `desktop: popped (peak ${peakScale(r.frames).toFixed(3)})`);

  // The bird while on the DM side: goes nowhere, only pops.
  const here = await path(a);
  await watch(a);
  await bird.click();
  r = await watched(a);
  check(r.navs.length === 0 && (await path(a)) === here && here === dmPath, `desktop: the bird in a DM stays (${JSON.stringify(r.navs)})`);
  check(peakScale(r.frames) > 1.08 && r.frames.every((f) => f[1] > 0.99), 'desktop: popped, still facing left');

  // An unread DM from Carol, while in the guild: her picture covers the bird; opening it brings
  // the bird back.
  await a.getByRole('link', { name: 'One', exact: true }).click();
  await a.waitForTimeout(700);
  await openChat(carol.page, alice.id);
  await send(carol.page, 'hi alice');
  const picture = a.getByRole('link', { name: /^Direct Messages: new message from/ });
  await picture.waitFor({ timeout: 10000 });
  check(await a.locator('.rail-logo').count() === 0 && await picture.locator('img').count() === 1, 'desktop: an unread DM shows its sender\'s picture instead of the bird');
  await shot(a, 'desktop-unread');
  await picture.click();
  await a.waitForURL(`**/dm/${carol.id}`);
  await a.waitForSelector('.rail-logo');
  check(await facing(a) > 0.99, 'desktop: opening it brings the bird back, facing left');

  // Reduced motion: the change happens with no turn.
  await a.emulateMedia({ reducedMotion: 'reduce' });
  check(await a.evaluate(() => getComputedStyle(document.querySelector('.rail-logo')).transitionDuration) === '0s', 'reduced motion: no transition');
  await watch(a);
  await a.getByRole('link', { name: 'One', exact: true }).click();
  r = await watched(a);
  check(r.frames.filter((f) => Math.abs(f[1]) < 0.99).length === 0 && r.frames[r.frames.length - 1][1] < -0.99, 'reduced motion: faces right at once');
  await a.emulateMedia({ reducedMotion: 'no-preference' });

  // Phone, on the DM list: the bird faces left; a guild turns it round, the bird turns it back.
  // The rail is on the list pane: open the chat, then Back to the list.
  const b = bob.page;
  await b.goto(`${BASE}/dm/${alice.id}`);
  await b.waitForSelector('#dm-input');
  await b.waitForTimeout(500);
  await b.evaluate(() => history.back());
  await b.waitForFunction(() => document.querySelector('.main-wrapper.pane-list:not(.panes-moving)'));
  await b.waitForTimeout(200);
  check(await facing(b) > 0.99, 'phone: faces left on the DM list');
  await shot(b, 'phone-dm');
  await b.tap(`.rail-guild[href="/guild/${one.id}"]`);
  await b.waitForURL(`**/guild/${one.id}/**`);
  await b.waitForTimeout(700);
  if (await b.locator('.rail-logo').isVisible()) {
    check(await facing(b) < -0.99, 'phone: faces right in a guild');
    await shot(b, 'phone-guild');
    await b.tap('.rail-bird');
    await b.waitForURL('**/dm**');
    await b.waitForTimeout(700);
    check(await facing(b) > 0.99, 'phone: faces left again in the DMs');
  } else {
    // The guild opened on its chat: Back shows the channel list, with the rail.
    await b.evaluate(() => history.back());
    await b.waitForTimeout(700);
    check(await facing(b) < -0.99, 'phone: faces right in a guild');
    await shot(b, 'phone-guild');
  }
} catch (err) {
  console.error('birdbutton: FAILED', err.message.split('\n')[0]);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
