// Voice messages: a computer records one from the + menu (live waveform, Stop, listen, Send),
// the other side gets it live and plays it (time moves, bars fill, speed), it can't be edited;
// on a phone the mic is in Send's place while the box is empty (typing brings Send back), a tap
// only says how, a hold sends on letting go, sliding left cancels, sliding up locks.
//   node e2e/serve.mjs &   then   node e2e/voicemessages.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, makeFriends, fakeMicArgs, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};
const voiceCount = (page) => page.locator('.dm-message-content .voice-message, .each-dm-message-wrapper .voice-message').count();

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const phone = { ...devices['Pixel 7'] };
  const bob = await signUp(browser, 'bob', phone);
  await makeFriends(alice, bob);
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  const a = alice.page;
  const b = bob.page;

  console.log('computer: + menu → Voice message');
  await a.click('button[aria-label="Add"]');
  await a.click('[role="menuitem"]:has-text("Voice message")');
  await a.waitForSelector('.voice-recorder .voice-recording-dot.live');
  await a.waitForTimeout(2500);
  const liveBars = await a.$$eval('.voice-recording-wave .voice-message-bar', (bars) => bars.map((x) => x.style.height));
  check(new Set(liveBars).size > 3, `live waveform moves (${new Set(liveBars).size} heights)`);
  check(await a.isHidden('#dm-input'), 'message box gives way to the recording');
  check(await a.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Send voice message', 'Send has the focus');
  await shot(a, 'desktop-recording');
  await a.click('button[aria-label="Stop recording"]');
  await a.waitForSelector('.voice-recorder .voice-message');
  const reviewTime = await a.textContent('.voice-recorder .voice-message-time');
  check(/^0:0[2-3]$/.test(reviewTime), `review shows the length (${reviewTime})`);
  await shot(a, 'desktop-review');
  await a.click('button[aria-label="Send voice message"]');
  await a.waitForSelector('#dm-input', { state: 'visible' });

  // Bob gets it live.
  await b.waitForSelector('.each-dm-message-wrapper .voice-message', { timeout: 20000 });
  check(await voiceCount(b) === 1, 'the other side has it live');
  const shown = await b.textContent('.each-dm-message-wrapper .voice-message-time');
  check(/^0:0[2-3]$/.test(shown), `its length before playing (${shown})`);
  const heights = await b.$$eval('.each-dm-message-wrapper .voice-message-bar', (bars) => bars.map((x) => x.style.height));
  check(heights.length === 40 && new Set(heights).size > 3, 'its waveform came with it');

  // Alice's own (sent): can't be edited.
  await a.waitForTimeout(800);
  await a.hover('.each-dm-message-wrapper .voice-message');
  await a.waitForSelector('.message-menu');
  const tools = await a.$$eval('.message-menu button svg', (icons) => icons.map((x) => x.getAttribute('data-icon')));
  check(tools.includes('reply') && tools.includes('trash'), `toolbar there (${tools.join(', ')})`);
  check(!tools.includes('pen-to-square'), 'no Edit on a voice message');
  await shot(a, 'desktop-sent');

  // Bob plays it (on the phone).
  await b.tap('.each-dm-message-wrapper button[aria-label="Play voice message"]');
  await b.waitForSelector('.each-dm-message-wrapper .voice-message.playing', { timeout: 15000 });
  await b.waitForTimeout(1200);
  const played = await b.locator('.each-dm-message-wrapper .voice-message-bar.played').count();
  const position = await b.evaluate(() => document.querySelector('.each-dm-message-wrapper .voice-message audio').currentTime);
  check(position > 0.5 && played > 0, `plays (at ${position.toFixed(1)} s, ${played} bars filled)`);
  await b.tap('.each-dm-message-wrapper .voice-message-rate');
  check(await b.evaluate(() => document.querySelector('.each-dm-message-wrapper .voice-message audio').playbackRate) === 1.5, 'speed 1.5×');
  await shot(b, 'phone-playing');
  await b.waitForSelector('.each-dm-message-wrapper .voice-message:not(.playing)', { timeout: 10000 });
  const duration = await b.evaluate(() => document.querySelector('.each-dm-message-wrapper .voice-message audio').duration);
  check(Number.isFinite(duration), `the recording's length found (${duration.toFixed(1)} s)`);
  // Seeking: halfway along the waveform.
  const wave = await b.locator('.each-dm-message-wrapper .voice-message-wave').boundingBox();
  await b.tap('.each-dm-message-wrapper .voice-message-wave', { position: { x: wave.width / 2, y: wave.height / 2 } });
  await b.waitForTimeout(300);
  const seeked = await b.evaluate(() => document.querySelector('.each-dm-message-wrapper .voice-message audio').currentTime);
  check(seeked > duration * 0.3, `seeks by tapping the waveform (to ${seeked.toFixed(1)} s)`);
  await b.evaluate(() => document.querySelector('.each-dm-message-wrapper .voice-message audio').pause());

  console.log('phone: the mic');
  const mic = 'button[aria-label="Record a voice message"]';
  check(await b.isVisible(mic) && !(await b.isVisible('button.send-button')), 'mic in Send’s place while the box is empty');
  await b.tap('#dm-input');
  await b.keyboard.type('hi');
  check(await b.isVisible('button.send-button') && !(await b.isVisible(mic)), 'typing brings Send back');
  await b.keyboard.press('Backspace');
  await b.keyboard.press('Backspace');
  await b.waitForSelector(mic);
  await b.evaluate(() => document.activeElement?.blur());

  const cdp = await b.context().newCDPSession(b);
  const box = await b.locator(mic).boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });

  // A tap: only how to.
  await touch('touchStart', at);
  await b.waitForTimeout(150);
  await touch('touchEnd');
  await b.waitForSelector('.voice-hint');
  check(true, 'a tap says "Hold to record, release to send"');
  await shot(b, 'phone-hint');
  await b.waitForTimeout(800);

  // A hold: sent on letting go.
  await touch('touchStart', at);
  await b.waitForSelector('.voice-slide-cancel');
  await b.waitForSelector('.voice-lock');
  await b.waitForTimeout(1800);
  await shot(b, 'phone-holding');
  await touch('touchEnd');
  await a.waitForFunction(() => document.querySelectorAll('.each-dm-message-wrapper .voice-message').length === 2, null, { timeout: 20000 });
  check(true, 'a hold sends on letting go');

  // Sliding left: cancelled.
  await b.waitForTimeout(500);
  await touch('touchStart', at);
  await b.waitForTimeout(1200);
  for (let dx = 20; dx <= 160; dx += 20) await touch('touchMove', { x: at.x - dx, y: at.y });
  await touch('touchEnd');
  await b.waitForTimeout(1500);
  check(await voiceCount(a) === 2 && await b.isVisible('#dm-input'), 'sliding left cancels');

  // Sliding up: locked, then sent with Send.
  await touch('touchStart', at);
  await b.waitForTimeout(1200);
  for (let dy = 20; dy <= 120; dy += 20) await touch('touchMove', { x: at.x, y: at.y - dy });
  await touch('touchEnd');
  await b.waitForSelector('button[aria-label="Delete recording"]');
  await b.waitForTimeout(800);
  check(await b.isVisible('.voice-recording-dot.live'), 'sliding up locks: still recording after letting go');
  await shot(b, 'phone-locked');
  await b.tap('button[aria-label="Send voice message"]');
  await a.waitForFunction(() => document.querySelectorAll('.each-dm-message-wrapper .voice-message').length === 3, null, { timeout: 20000 });
  check(true, 'Send sends the locked recording');

  // Fits the phone: nothing wider than the screen.
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, 'nothing wider than the phone');
  await shot(b, 'phone-sent');

  // The conversation list's preview.
  await a.goto(a.url());
  await a.waitForSelector('.each-dm-message-wrapper .voice-message');
  check(await voiceCount(a) === 3, 'still there after a reload');
  await a.emulateMedia({ colorScheme: 'dark' });
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await shot(a, 'desktop-dark');
  console.log('voicemessages: ok');
} catch (err) {
  console.error('voicemessages: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
