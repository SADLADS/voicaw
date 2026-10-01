// Sounds: Settings → Sounds (play buttons, switches), mute/deafen sounds, the Message sound
// (plays when another chat is open, not in the sender's chat, not when turned off), phone layout.
//   node e2e/serve.mjs &   then   node e2e/sounds.mjs [screenshot dir]
// A sound playing is seen as oscillators being made in the page's AudioContext.
import { launchChrome, signUp, openChat, send, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });

// Counts oscillators made (each note of a tone is one).
function countSounds() {
  window.__oscillators = 0;
  const original = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function (...args) {
    window.__oscillators++;
    return original.apply(this, args);
  };
}
const made = (page) => page.evaluate(() => window.__oscillators);

async function instrument(page) {
  await page.context().addInitScript(countSounds);
  await page.reload();
  await page.waitForSelector('#dm-main');
  // Browsers only start audio after a click.
  await page.mouse.click(5, 5);
}

async function grew(page, before, what) {
  await page.waitForFunction((n) => window.__oscillators > n, before, { timeout: 8000 })
    .catch(() => { throw new Error(`no sound for ${what}`); });
}

async function stayed(page, before, what) {
  await page.waitForTimeout(2500);
  const now = await made(page);
  if (now !== before) throw new Error(`unexpected sound for ${what} (${before} → ${now})`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await instrument(bob.page);

  // Settings → Sounds: every sound listed, play buttons play.
  await bob.page.goto(`${BASE}/settings#sounds`);
  await bob.page.waitForSelector('.sound-settings');
  const rows = await bob.page.locator('.sound-list li').count();
  if (rows !== 10) throw new Error(`expected 10 sounds, saw ${rows}`);
  let before = await made(bob.page);
  await bob.page.click('[aria-label="Play User join"]');
  await grew(bob.page, before, 'Play User join');
  await shot(bob.page, 'sounds-settings');

  // Mute and deafen buttons in the user panel.
  before = await made(bob.page);
  await bob.page.click('[aria-label="Mute"]');
  await grew(bob.page, before, 'mute');
  before = await made(bob.page);
  await bob.page.click('[aria-label="Unmute"]');
  await grew(bob.page, before, 'unmute');
  before = await made(bob.page);
  await bob.page.click('[aria-label="Deafen"]');
  await grew(bob.page, before, 'deafen');
  await bob.page.click('[aria-label="Undeafen"]');

  // Message: Bob in his notes (another chat) hears Alice's DM.
  await openChat(alice.page, bob.id);
  await bob.page.goto(`${BASE}/dm/notes`);
  await bob.page.waitForSelector('#dm-input');
  await bob.page.mouse.click(5, 5);
  await bob.page.waitForTimeout(1000); // presence reaches the server
  before = await made(bob.page);
  await send(alice.page, 'ding one');
  await grew(bob.page, before, 'a DM while in another chat');

  // Not while looking at Alice's chat.
  await openChat(bob.page, alice.id);
  await bob.page.mouse.click(5, 5);
  await bob.page.waitForTimeout(1500);
  before = await made(bob.page);
  await send(alice.page, 'seen already');
  await bob.page.waitForSelector('text=seen already', { timeout: 10000 });
  await stayed(bob.page, before, 'a DM in the open chat');

  // Not once the Message sound is switched off.
  await bob.page.goto(`${BASE}/settings#sounds`);
  await bob.page.waitForSelector('.sound-settings');
  await bob.page.locator('.sound-list li', { hasText: 'Message' }).locator('input[type="checkbox"]').uncheck();
  await bob.page.waitForTimeout(1000);
  before = await made(bob.page);
  await send(alice.page, 'quiet please');
  await stayed(bob.page, before, 'a DM with the Message sound off');

  // Phone layout.
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  await phone.page.goto(`${BASE}/settings#sounds`);
  await phone.page.waitForSelector('.sound-settings');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Sounds settings scroll sideways on a phone');
  await phone.page.locator('.sound-settings').scrollIntoViewIfNeeded();
  await shot(phone.page, 'sounds-phone');

  console.log('sounds: ok');
} catch (err) {
  console.error('sounds: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
