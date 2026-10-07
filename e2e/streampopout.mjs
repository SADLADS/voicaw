// Popping a screen share out into its own window (voice/streamWindow.js), through the e2e
// LiveKit: Alice shares, Bob watches and clicks Pop out. A real window opens with the stream
// playing, styled like the app (theme followed live); the channel page shows a note instead.
// It keeps playing on another page. Full screen works in it. Closing it brings the stream back
// to the channel page; so does Bring back (in the window or the note). Stop watching, the stream
// ending and leaving voice close it. Carol, on a phone, gets no Pop out.
//   node e2e/serve.mjs &   then   node e2e/streampopout.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const videoPlaying = (page) => page.waitForFunction(() => {
  const v = document.querySelector('.stream-view video');
  return v && v.videoWidth > 0 && !v.paused && v.currentTime > 0.3;
}, null, { timeout: 20000 });

// Still playing: the video's time moves on.
async function stillPlaying(page) {
  const t = await page.$eval('.stream-view video', (v) => v.currentTime);
  await page.waitForTimeout(1500);
  const later = await page.$eval('.stream-view video', (v) => v.currentTime);
  if (!(later > t + 0.5)) throw new Error(`the popped-out stream stopped (${t} → ${later})`);
}

// Does `action`, which should close window `w` (waiting from before, as it may close at once).
async function closesWindow(w, action, timeout = 5000) {
  await Promise.all([w.waitForEvent('close', { timeout }), action()]);
}

const tile = (name) => `.voice-tile:has-text("${name}")`;
const live = (selector) => `${selector} .voice-live-badge`;

// Clicks Pop out and returns the window it opened.
async function popOut(page) {
  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    page.click('.stream-view button[aria-label="Pop out"]'),
  ]);
  await popup.waitForSelector('.stream-view.popped-out');
  await videoPlaying(popup);
  await page.waitForSelector('.stream-popped-note');
  return popup;
}

const browser = await launchChrome({ args: [...fakeMicArgs(), '--auto-select-desktop-capture-source=Entire screen'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  const c = carol.page;
  for (const [who, page] of [['alice', a], ['bob', b], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Popout Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  const guildId = /\/guild\/(\d+)/.exec(a.url())[1];
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const channelId = /\/guild\/\d+\/(\d+)/.exec(a.url())[1];

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);
  await joinWith(c, link);

  for (const page of [a, b]) {
    await page.click('.guild-channel-link:has-text("lounge")');
    await page.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  }
  await a.waitForSelector(tile(bob.name));
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")'); // the quality dialog first
  await a.waitForSelector('.voice-bar button[aria-label="Stop sharing your screen"]', { timeout: 10000 });
  await b.waitForSelector(live(tile(alice.name)), { timeout: 10000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  console.log('bob watches alice');

  // Pop out: a real window with the stream, styled like the app; a note on the channel page.
  let w = await popOut(b);
  const look = await w.evaluate(() => {
    const stage = document.querySelector('.stream-view').getBoundingClientRect();
    const button = getComputedStyle(document.querySelector('.stream-button'));
    return {
      title: document.title,
      theme: document.documentElement.dataset.theme,
      fills: stage.width === innerWidth && stage.height === innerHeight,
      button: `${button.width} ${button.borderRadius}`,
      bring: Boolean(document.querySelector('button[aria-label="Bring back"]')),
      size: `${innerWidth}x${innerHeight}`,
    };
  });
  console.log('popped out:', JSON.stringify(look));
  if (look.title !== `${alice.name}'s screen – Voicaw`) throw new Error(`window title: ${look.title}`);
  if (!look.fills || look.button !== '32px 50%' || !look.bring) throw new Error('the window is not styled like the app');
  if (await b.$('.stream-view')) throw new Error('the stream is still on the channel page too');
  const note = await b.textContent('.stream-popped-note');
  console.log('channel page says:', note);
  await shot(w, '01-popped-out-window');
  await shot(b, '02-channel-page-note');

  // The theme follows the app's at once.
  const theme = await b.evaluate(() => document.documentElement.dataset.theme);
  await b.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await w.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await b.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  console.log('theme followed');

  // Another page: it carries on.
  await b.click('.guild-channel-link:has-text("general")');
  await b.waitForSelector('#dm-input');
  await stillPlaying(w);
  console.log('still playing while bob is in #general');

  // Full screen inside the window.
  await w.click('.stream-view button[aria-label="Full screen"]');
  await w.waitForFunction(() => document.fullscreenElement?.classList.contains('stream-view'));
  await w.click('.stream-view button[aria-label="Full screen"]');
  await w.waitForFunction(() => !document.fullscreenElement);
  console.log('full screen works in the window');

  // Closing the window (its own close button): the stream is back on the channel page.
  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector('.stream-popped-note');
  await w.close();
  await b.waitForSelector('.stream-popped-note', { state: 'detached', timeout: 5000 });
  await videoPlaying(b);
  console.log('closing the window put the stream back');

  // Bring back, from the window.
  w = await popOut(b);
  await closesWindow(w, () => w.click('button[aria-label="Bring back"]'));
  await videoPlaying(b);
  console.log('Bring back (window) works');

  // Bring back, from the note.
  w = await popOut(b);
  await closesWindow(w, () => b.click('.stream-popped-note button:has-text("Bring back")'));
  await videoPlaying(b);
  console.log('Bring back (note) works');

  // Stop watching, from the note: the window goes, and nothing shows.
  w = await popOut(b);
  await closesWindow(w, () => b.click('.stream-popped-note button:has-text("Stop watching")'));
  if (await b.$('.stream-view')) throw new Error('still showing after Stop watching');
  console.log('Stop watching closed it');

  // Popping out again opens a window again (the old one is gone, not reused wrongly).
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  w = await popOut(b);
  // Leaving voice closes it.
  await closesWindow(w, () => b.click('.voice-bar button[aria-label="Disconnect"]'));
  console.log('leaving voice closed it');

  // The stream ending closes it.
  await b.click('.voice-view-join');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await b.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(b);
  w = await popOut(b);
  await closesWindow(w, () => a.click('.voice-bar button[aria-label="Stop sharing your screen"]'), 10000);
  console.log('the stream ending closed it');

  // A phone gets no Pop out (a "window" there is just a tab).
  await a.click('.voice-bar button[aria-label="Share your screen"]');
  await a.click('.go-live-dialog button:has-text("Go Live")'); // the quality dialog first
  await c.goto(`${BASE}/guild/${guildId}/${channelId}`);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await c.click(`${tile(alice.name)} .voice-tile-watch`);
  await videoPlaying(c);
  if (await c.$('.stream-view button[aria-label="Pop out"]')) throw new Error('a phone offers Pop out');
  console.log('phone: no Pop out');
  await shot(c, '03-phone-no-popout');
  console.log('OK');
} finally {
  await browser.close();
}
