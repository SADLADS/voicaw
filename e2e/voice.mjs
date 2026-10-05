// Voice channels in real browsers, through the e2e LiveKit (serve.mjs starts one): Alice makes
// a voice channel and joins it by clicking it; Bob sees her in it, joins, and hears her
// (the fake microphone plays a speech-like sound, which lights up her "speaking" ring). Mute
// and deafen show for everyone. Carol, on a phone, opens the channel and joins from its page.
// Leaving, and closing the tab, take people out.
//   node e2e/serve.mjs &   then   node e2e/voice.mjs [screenshot dir]
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

// The <audio> elements playing other people, and whether they're actually playing.
const playing = (page) => page.$$eval('[data-voice-audio] audio', (els) =>
  els.map((a) => ({ paused: a.paused, muted: a.muted, time: a.currentTime })));

const tile = (name) => `.voice-tile:has-text("${name}")`;
const sidebarMember = (name) => `.voice-member:has-text("${name}")`;

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
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Voice Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');

  // Create Channel → Voice → "Lounge". Creating it opens it, without joining.
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const loungeUrl = a.url();
  console.log('voice channel page:', loungeUrl.replace(BASE, ''));
  await shot(a, '01-empty-voice-channel');

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(b, link);

  // Desktop: clicking the channel joins it.
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  console.log('alice connected');
  await b.waitForSelector(sidebarMember(alice.name), { timeout: 10000 });
  console.log('bob sees alice in the channel list');

  await b.click('.guild-channel-link:has-text("lounge")');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await a.waitForSelector(tile(bob.name));
  console.log('bob connected; alice sees his tile');

  // Bob hears Alice: her audio plays on his side, and her tone lights her ring.
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  console.log('bob sees alice speaking');
  // Only the tile is outlined, not the picture inside it; the channel list's picture is ringed.
  await b.waitForSelector(`${sidebarMember(alice.name)} .user-avatar.speaking`, { timeout: 5000 });
  if (await b.$(`${tile(alice.name)} .user-avatar.speaking`)) throw new Error('tile picture ringed too');
  const ring = await b.$eval(`${tile(alice.name)} .user-avatar`, (el) => getComputedStyle(el).boxShadow);
  if (ring !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(ring)) throw new Error(`tile picture has a ring: ${ring}`);
  console.log('only the tile and the channel list picture light up');
  await b.waitForFunction(() => [...document.querySelectorAll('[data-voice-audio] audio')].some((el) => !el.paused && el.currentTime > 0.5), null, { timeout: 10000 });
  console.log('bob playing:', JSON.stringify(await playing(b)));
  await shot(b, '02-bob-in-voice-alice-speaking');

  // Alice mutes: Bob sees it, and her ring goes out.
  await a.click('.user-panel button[aria-label="Mute"]');
  await b.waitForSelector(`${tile(alice.name)} [aria-label="Muted"]`);
  await b.waitForSelector(`${tile(alice.name)}:not(.speaking)`, { timeout: 10000 });
  console.log('alice muted: bob sees the icon, and she stops "speaking"');
  // Deafen: her side stops playing Bob, Bob sees it.
  await a.click('.user-panel button[aria-label="Deafen"]');
  await b.waitForSelector(`${tile(alice.name)} [aria-label="Deafened"]`);
  console.log('alice deafened; her audio elements:', JSON.stringify(await playing(a)));
  await shot(a, '03-alice-muted-deafened');
  await shot(b, '04-bob-sees-alice-muted-deafened');
  // Undeafen and unmute in one go (unmute undeafens, like Discord).
  await a.click('.user-panel button[aria-label="Unmute"]');
  await b.waitForSelector(`${tile(alice.name)}:not(:has([aria-label="Muted"]))`);
  await b.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  console.log('alice unmuted: speaking again');

  // Carol on a phone: opening the channel doesn't join it; she joins from its page.
  await joinWith(c, link);
  // (On a phone the guild opens on a channel, its list underneath: open the voice one directly.)
  await c.goto(loungeUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await c.waitForSelector('.voice-view-join');
  await c.waitForTimeout(600); // the slide over to the content
  await shot(c, '05-carol-phone-before-joining');
  if (await c.$('.voice-bar')) throw new Error('tapping the channel joined on mobile');
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await a.waitForSelector(tile(carol.name));
  console.log('carol joined from the page');
  await c.waitForSelector(`${tile(alice.name)}.speaking`, { timeout: 15000 });
  await shot(c, '06-carol-phone-in-voice');

  // Bob leaves with the voice bar's button.
  await b.click('.voice-bar-leave');
  await a.waitForSelector(tile(bob.name), { state: 'detached', timeout: 10000 });
  console.log('bob left');
  await shot(a, '07-alice-after-bob-left');

  // Alice closes her tab: LiveKit notices, and she's gone for Carol.
  await a.close();
  await c.waitForSelector(tile(alice.name), { state: 'detached', timeout: 30000 });
  console.log('alice closed her tab: gone');
  await shot(c, '08-carol-alone');
  console.log('OK');
} finally {
  await browser.close();
}
