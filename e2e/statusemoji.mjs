// Custom status emoji: in the user menu the emoji button shows without editing (one click opens
// the picker, the pick saves at once), then Alice adds "Out for lunch" (the picker during the
// edit doesn't end it), Bob sees both live in his DM list; Edit Profile removes the emoji
// (preview, save, Bob sees text only); a status that is only an emoji, kept after a reload;
// phone (menu and picker fit).
//   node e2e/serve.mjs &   then   node e2e/statusemoji.mjs [dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

function check(ok, what) {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
}

// Bob's DM list row for Alice: its status's emoji (alt or text) and text.
const rowStatus = (page, id) => page.evaluate((id) => {
  const status = document.querySelector(`a[href="/dm/${id}"] .dm-user-custom-status`);
  if (!status) return null;
  const img = status.querySelector('.custom-status-emoji img');
  return {
    emoji: img ? img.alt : status.querySelector('.custom-status-emoji')?.textContent ?? null,
    loaded: img ? img.complete && img.naturalWidth > 0 : null,
    text: status.querySelector('.custom-status-text')?.textContent ?? null,
  };
}, id);

async function waitForStatus(page, id, expected) {
  await page.waitForFunction(([id, e]) => {
    const status = document.querySelector(`a[href="/dm/${id}"] .dm-user-custom-status`);
    if (!status) return e === null;
    if (e === null) return false;
    const emoji = status.querySelector('.custom-status-emoji img')?.alt ?? null;
    const text = status.querySelector('.custom-status-text')?.textContent ?? null;
    return emoji === e.emoji && text === e.text;
  }, [id, expected], { timeout: 10000 });
}

async function openMenu(page) {
  await page.click('.user-panel-me');
  await page.waitForSelector('.user-menu');
}

async function pickEmoji(page, search) {
  await page.waitForSelector('.emoji-picker-search');
  await page.fill('.emoji-picker-search', search);
  await page.click('.emoji-picker-item >> nth=0');
  await page.waitForSelector('.emoji-picker', { state: 'detached' });
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await makeFriends(alice, bob);
  const a = alice.page;
  const b = bob.page;
  await b.goto(`${BASE}/dm`);
  await b.waitForSelector(`a[href="/dm/${alice.id}"]`);

  console.log('user menu: the emoji button, one click');
  await openMenu(a);
  check(await a.isVisible('.user-menu .status-emoji-button'), 'the emoji button shows without editing');
  check(!(await a.isVisible('.user-menu-status-input')), 'no text box until the text is clicked');
  await shot(a, '0-menu');
  await a.click('.user-menu .status-emoji-button');
  await a.waitForSelector('.user-menu .emoji-picker');
  check(true, 'one click opens the picker');
  check(await a.isVisible('.user-menu'), 'the menu stays open with the picker');
  const box = await a.$eval('.user-menu .emoji-picker', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  check(box.left >= 0 && box.top >= 0 && box.right <= 1100 && box.bottom <= 750, 'the picker is inside the window');
  await shot(a, '1-menu-picker');
  await pickEmoji(a, 'rabbit');
  // Whichever "rabbit" search puts first (🐰 or 🐇).
  const rabbit = await a.getAttribute('.user-menu .status-emoji-button img', 'alt');
  check(['🐰', '🐇'].includes(rabbit), `the button shows the rabbit (${rabbit})`);
  await waitForStatus(b, alice.id, { emoji: rabbit, text: null });
  check(true, 'the pick saved at once (Bob sees it)');

  console.log('user menu: text, with the picker during the edit');
  await a.click('button:has-text("Set a custom status")');
  await a.fill('.user-menu-status-input', 'Out for lunch');
  await a.click('.user-menu .status-emoji-button');
  await a.waitForSelector('.user-menu .emoji-picker');
  // Nothing saved: the picker isn't leaving the edit.
  check((await rowStatus(b, alice.id)).text === null, 'opening the picker saved nothing');
  await pickEmoji(a, 'rabbit');
  check(await a.isVisible('.user-menu-status-input'), 'still editing after the pick');
  check(await a.evaluate(() => document.activeElement?.classList.contains('user-menu-status-input')), 'the text box has the focus back');
  await shot(a, '2-menu-editing');
  await a.press('.user-menu-status-input', 'Enter');
  await a.waitForSelector('.user-menu-status:has-text("Out for lunch")');
  check((await a.getAttribute('.user-menu .status-emoji-button img', 'alt')) === rabbit, 'the menu shows emoji and text');
  await shot(a, '3-menu-saved');
  const panel = await a.$eval('.user-panel-state', (el) => ({
    emoji: el.querySelector('.custom-status-emoji img')?.alt ?? null,
    text: el.querySelector('.custom-status-text')?.textContent ?? null,
    fits: el.scrollWidth <= el.clientWidth || getComputedStyle(el).textOverflow === 'ellipsis',
  }));
  check(panel.emoji === rabbit && panel.text === 'Out for lunch' && panel.fits, 'your user panel shows it under your name instead of Online');

  await waitForStatus(b, alice.id, { emoji: rabbit, text: 'Out for lunch' });
  await b.waitForFunction((id) => {
    const img = document.querySelector(`a[href="/dm/${id}"] .custom-status-emoji img`);
    return img?.complete && img.naturalWidth > 0;
  }, alice.id);
  check(true, "Bob's DM list shows it live, the Twemoji drawn");
  const sizes = await b.$eval(`a[href="/dm/${alice.id}"] .dm-user-custom-status`, (el) => {
    const img = el.querySelector('img').getBoundingClientRect();
    return { img: img.height, line: el.getBoundingClientRect().height };
  });
  check(sizes.img > 10 && sizes.img <= sizes.line + 1, `emoji sized to the line (${sizes.img.toFixed(1)}px in ${sizes.line.toFixed(1)}px)`);
  await shot(b, '4-bob-dm-list');

  console.log('Edit Profile: remove the emoji');
  await a.keyboard.press('Escape');
  await a.goto(`${BASE}/settings/profile`);
  await a.waitForSelector(`.edit-profile-status .status-emoji-button img[alt="${rabbit}"]`);
  check((await a.inputValue('#edit-profile-status')) === 'Out for lunch', 'the form starts from the saved status');
  await shot(a, '5-edit-profile');
  await a.click('.edit-profile-status .status-emoji-remove');
  await a.waitForSelector('.edit-profile-preview .profile-card-custom-status .custom-status-emoji', { state: 'detached' });
  check(true, 'the preview drops the emoji');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('text=Profile saved.');
  await waitForStatus(b, alice.id, { emoji: null, text: 'Out for lunch' });
  check(true, 'Bob sees the text alone');

  console.log('Edit Profile: an emoji only');
  await a.fill('#edit-profile-status', '');
  await a.click('.edit-profile-status .status-emoji-button');
  await pickEmoji(a, 'coffee');
  const coffee = await a.getAttribute('.edit-profile-status .status-emoji-button img', 'alt');
  await a.click('button:has-text("Save changes")');
  await a.waitForSelector('text=Profile saved.');
  await waitForStatus(b, alice.id, { emoji: coffee, text: null });
  check(true, 'Bob sees only the emoji');
  await shot(b, '6-bob-emoji-only');

  await b.goto(`${BASE}/dm/${alice.id}`);
  await b.waitForSelector('#dm-input');
  await b.reload();
  await waitForStatus(b, alice.id, { emoji: coffee, text: null });
  check(true, 'still there after a reload');

  console.log('phone');
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(BASE);
  await p.evaluate((token) => localStorage.setItem('token', token), await a.evaluate(() => localStorage.getItem('token')));
  await p.goto(`${BASE}/dm`);
  // The Friends page is in front: back to the list, where the user panel is.
  await p.tap('.pane-back-button');
  await p.waitForSelector('.user-panel-me', { state: 'visible' });
  await openMenu(p);
  await p.click('.user-menu-status');
  await p.waitForSelector('.user-menu-status-input');
  await p.tap('.user-menu .status-emoji-button');
  await p.waitForSelector('.user-menu .emoji-picker');
  const vw = await p.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const pbox = await p.$eval('.user-menu .emoji-picker', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  const mbox = await p.$eval('.user-menu', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  await shot(p, '7-phone-picker');
  check(pbox.left >= 0 && pbox.top >= 0 && pbox.right <= vw.w && pbox.bottom <= vw.h, `the picker fits the phone (${JSON.stringify(pbox)} in ${vw.w}×${vw.h})`);
  check(mbox.left >= 0 && mbox.right <= vw.w, 'the menu fits the phone');
  await p.fill('.emoji-picker-search', 'tent');
  await p.tap('.emoji-picker-item >> nth=0');
  await p.waitForSelector('.emoji-picker', { state: 'detached' });
  await p.fill('.user-menu-status-input', 'Camping');
  await p.press('.user-menu-status-input', 'Enter');
  await p.waitForSelector('.user-menu-status:has-text("Camping")');
  check((await p.getAttribute('.user-menu .status-emoji-button img', 'alt')) === '⛺', 'the phone menu shows the tent');
  await shot(p, '8-phone-saved');
  await waitForStatus(b, alice.id, { emoji: '⛺', text: 'Camping' });
  check(true, 'set from a phone, Bob sees it');
  await phone.close();

  console.log('statusemoji: ok');
} catch (err) {
  console.error('statusemoji: FAILED', err.message.split('\n')[0]);
  for (const [i, page] of browser.contexts().flatMap((c) => c.pages()).entries()) await shot(page, `failed-${i}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
