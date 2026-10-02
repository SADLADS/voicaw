// Per-user volume in real browsers, through the e2e LiveKit: Alice and Bob in a voice channel;
// Bob clicks Alice (in the channel list and on her tile) and sets her volume. How loud she
// really plays on Bob's side is measured from the Web Audio graph (an analyser on every gain
// that feeds the speakers): 100%, 200% (louder), 0% (silent), deafened (silent), Reset. It's
// remembered after a reload. Yourself and people in a channel you're not in can't be set.
// Carol, on a phone, gets a sheet. Then a DM call: clicking the other person in the call panel.
//   node e2e/serve.mjs &   then   node e2e/uservolume.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// Taps every GainNode connected to a destination with an analyser, so the page can say how
// loud what it plays is.
const tapOutput = () => {
  window.__taps = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function tapped(target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (this instanceof GainNode && target instanceof AudioDestinationNode && !this.__tapped) {
      this.__tapped = true;
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      connect.call(this, analyser);
      window.__taps.push(analyser);
    }
    return result;
  };
};

// The loudest RMS any tapped output reaches over `ms`.
const level = (page, ms = 1500) => page.evaluate(async (ms) => {
  const end = performance.now() + ms;
  let max = 0;
  while (performance.now() < end) {
    for (const analyser of window.__taps ?? []) {
      if (analyser.context.state === 'closed') continue;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
      max = Math.max(max, rms);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return max;
}, ms);

const tile = (name) => `.voice-tile:has-text("${name}")`;
const sidebarMember = (name) => `.voice-member:has-text("${name}")`;
const menu = '.user-volume-menu';
const setSlider = (page, sel, value) => page.$eval(sel, (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log('ok:', what);
}

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated/.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
    await page.context().addInitScript(tapOutput);
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Volume Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const loungeUrl = a.url().replace(/^https?:\/\/[^/]+/, BASE);
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = (await a.inputValue('#invite-link')).replace(/^https?:\/\/[^/]+/, BASE);
  await a.keyboard.press('Escape');
  for (const page of [b, c]) {
    await page.goto(link);
    await page.click('button:has-text("Accept invite")');
    await page.waitForSelector('#dm-input');
  }

  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.goto(loungeUrl);
  await b.waitForSelector(sidebarMember(alice.name));

  // Not in the channel: Alice can't be set.
  check(!(await b.$(`${sidebarMember(alice.name)}[data-volume-trigger]`)), "outside the channel, no volume");

  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  check(!(await b.$(`${tile(bob.name)}[data-volume-trigger]`)), 'no volume for yourself');
  check(Boolean(await b.$(`${tile(alice.name)}[data-volume-trigger]`)), "Alice's tile opens a volume");

  const normal = await level(b);
  console.log('alice at 100%:', normal.toFixed(4));
  check(normal > 0.005, 'Bob hears Alice through Web Audio');

  // The channel list: click her name.
  await b.click(sidebarMember(alice.name));
  await b.waitForSelector(menu);
  check((await b.textContent(`${menu} .user-volume-value`)).trim() === '100%', 'starts at 100%');
  check(await b.$eval(`${menu} .user-volume-slider`, (el) => el === document.activeElement), 'slider has the focus');
  await shot(b, '01-volume-from-channel-list');
  await setSlider(b, `${menu} .user-volume-slider`, 200);
  await b.waitForSelector(`${menu} .user-volume-value:has-text("200%")`);
  await b.waitForTimeout(500);
  const loud = await level(b);
  console.log('alice at 200%:', loud.toFixed(4));
  check(loud > normal * 1.6, '200% is about twice as loud');
  await shot(b, '02-volume-200');

  // Keys work on the slider; Escape closes.
  await b.keyboard.press('ArrowLeft');
  await b.waitForSelector(`${menu} .user-volume-value:has-text("199%")`);
  await b.keyboard.press('Escape');
  await b.waitForSelector(menu, { state: 'detached' });

  // Her tile (right click): 0% is silent.
  await b.click(tile(alice.name), { button: 'right' });
  await b.waitForSelector(`${menu} .user-volume-value:has-text("199%")`);
  await setSlider(b, `${menu} .user-volume-slider`, 0);
  await b.waitForTimeout(600);
  const silent = await level(b);
  console.log('alice at 0%:', silent.toFixed(4));
  check(silent < normal * 0.05, '0% is silent');
  check(await b.$eval(tile(alice.name), (el) => el.classList.contains('speaking')), 'she still shows as speaking');

  // Reset; a click outside closes.
  await b.click(`${menu} .user-volume-reset`);
  await b.waitForSelector(`${menu} .user-volume-value:has-text("100%")`);
  check(await b.$eval(`${menu} .user-volume-reset`, (el) => el.disabled), 'Reset greys out at 100%');
  await b.mouse.click(5, 300);
  await b.waitForSelector(menu, { state: 'detached' });

  // 150%, then deafened is silent and undeafened is back at 150%.
  await b.click(tile(alice.name));
  await setSlider(b, `${menu} .user-volume-slider`, 150);
  await b.keyboard.press('Escape');
  await b.waitForTimeout(500);
  const boosted = await level(b);
  await b.click('.user-panel button[aria-label="Deafen"]');
  await b.waitForTimeout(600);
  const deaf = await level(b);
  await b.click('.user-panel button[aria-label="Undeafen"]');
  await b.waitForTimeout(600);
  const back = await level(b);
  console.log('150%:', boosted.toFixed(4), 'deafened:', deaf.toFixed(4), 'undeafened:', back.toFixed(4));
  check(deaf < normal * 0.05, 'deafened is silent');
  check(back > normal * 1.2, 'undeafened keeps her 150%');

  // Remembered on this device.
  await b.reload();
  await b.waitForSelector('.voice-view-join');
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click(tile(alice.name));
  check((await b.textContent(`${menu} .user-volume-value`)).trim() === '150%', 'kept after a reload');
  await b.keyboard.press('Escape');
  const afterReload = await level(b);
  console.log('after reload:', afterReload.toFixed(4));
  check(afterReload > normal * 1.2, 'and applied');

  // Carol on a phone: tapping Alice's tile gives a sheet.
  await c.goto(loungeUrl);
  await c.waitForSelector('.voice-view-join');
  await c.waitForTimeout(600);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await c.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  await c.tap(tile(alice.name));
  await c.waitForSelector('.user-volume-sheet');
  check((await c.textContent('.user-volume-sheet .context-sheet-title')).includes(alice.name), 'phone sheet names her');
  await setSlider(c, '.user-volume-sheet .user-volume-slider', 50);
  await c.waitForSelector('.user-volume-sheet .user-volume-value:has-text("50%")');
  await c.waitForTimeout(400); // the sheet's rise
  await shot(c, '03-phone-sheet');
  await c.tap('.action-sheet-backdrop', { position: { x: 20, y: 20 } });
  await c.waitForSelector('.user-volume-sheet', { state: 'detached' });
  await c.click('.voice-view-button.leave');
  await b.click('.voice-bar-leave');
  await a.click('.voice-bar-leave');

  // A DM call: click the other person in the call panel.
  await openChat(b, alice.id);
  await openChat(a, bob.id);
  await a.click(`button[aria-label="Call ${bob.name}"]:not([disabled])`);
  await b.waitForSelector('.incoming-call');
  await b.click('.incoming-call button[aria-label="Accept"]');
  await b.waitForSelector('.voice-bar-status.connected:has-text("Call Connected")', { timeout: 20000 });
  await b.waitForSelector('.call-panel .user-avatar.speaking', { timeout: 15000 });
  const callNormal = await level(b);
  check(callNormal > 0.005, 'Bob hears Alice in the encrypted call');
  // Alice's panel: Bob can be set, Alice herself can't.
  const triggers = await b.$$('.call-panel [data-volume-trigger]');
  check(triggers.length === 1, 'only the other person in the call panel');
  await triggers[0].click();
  await b.waitForSelector(menu);
  // She's still at 150% from the channel: per person, wherever you hear them.
  check((await b.textContent(`${menu} .user-volume-value`)).trim() === '150%', 'same volume in a call');
  await setSlider(b, `${menu} .user-volume-slider`, 0);
  await b.waitForTimeout(600);
  const callSilent = await level(b);
  console.log('call: 150%', callNormal.toFixed(4), '0%', callSilent.toFixed(4));
  check(callSilent < callNormal * 0.05, '0% silences her in the call');
  await shot(b, '04-call-panel-volume');
  await b.click(`${menu} .user-volume-reset`);
  await b.keyboard.press('Escape');
  await b.click('.call-panel button[aria-label="Hang up"]');
  console.log('OK');
} finally {
  await browser.close();
}
