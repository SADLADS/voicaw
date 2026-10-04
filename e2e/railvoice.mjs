// The guild rail's speaker: Alice joins a voice channel and her rail shows a green speaker on the
// guild; Carol, whose app hasn't opened the guild since a reload (so it only has the guild
// list), sees a grey one, live, and loses it when Alice leaves. Also on a phone (Dan), in the
// light theme, and with a mention badge (the speaker moves above it).
//   node e2e/serve.mjs &   then   node e2e/railvoice.mjs [screenshot dir]
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name, clip) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...(clip && { clip }) });
};
const railClip = { x: 0, y: 0, width: 90, height: 260 };

async function joinWith(page, link) {
  await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('#dm-input');
}

const badge = (name) => `.rail-guilds .nav-item:has(a[aria-label="${name}"]) .rail-voice-badge`;
const colours = (page, selector) => page.$eval(selector, (el) => {
  const style = getComputedStyle(el);
  return { background: style.backgroundColor, colour: style.color };
});

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const a = alice.page;
  const c = carol.page;
  const d = dan.page;
  for (const [who, page] of [['alice', a], ['carol', c], ['dan', d]]) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${who} ${m.type()}]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Rail Voice');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');

  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await joinWith(c, link);
  await joinWith(d, link);

  // Carol reloads onto her DMs: the guild's layout isn't loaded, only the list.
  await c.goto(`${BASE}/dm`);
  await c.waitForSelector('.rail-guilds a[aria-label="Rail Voice"]');
  if (await c.$(badge('Rail Voice'))) throw new Error('speaker shown with nobody in voice');

  // Alice joins: green on her rail, grey on Carol's (live), and on Dan's phone.
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await a.waitForSelector(`${badge('Rail Voice')}.self`);
  await c.waitForSelector(badge('Rail Voice'), { timeout: 10000 });
  if (await c.$(`${badge('Rail Voice')}.self`)) throw new Error("carol's speaker is green");
  console.log('alice (in voice):', JSON.stringify(await colours(a, badge('Rail Voice'))));
  console.log('carol (not in voice):', JSON.stringify(await colours(c, badge('Rail Voice'))));
  await shot(a, '01-alice-in-voice-rail', railClip);
  await shot(c, '02-carol-sees-voice-rail', railClip);
  await shot(a, '03-alice-whole');

  // After a reload Carol still sees it (from GET /guilds).
  await c.reload();
  await c.waitForSelector(badge('Rail Voice'), { timeout: 10000 });
  console.log('carol sees it after a reload, before opening the guild');

  // Dan on a phone (the rail is on the list pane).
  await d.goto(`${BASE}/dm`);
  await d.waitForSelector(badge('Rail Voice'), { state: 'attached', timeout: 10000 });
  // It opens on a chat: back slides to the list, where the rail is.
  await d.goBack();
  await d.waitForSelector(badge('Rail Voice'), { timeout: 10000 });
  await d.waitForTimeout(500);
  await shot(d, '04-dan-phone');
  console.log('dan (phone) sees it');

  // Light theme.
  await c.emulateMedia({ colorScheme: 'light' });
  await a.emulateMedia({ colorScheme: 'light' });
  await c.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await shot(c, '05-carol-light', railClip);
  await shot(a, '06-alice-light', railClip);
  await c.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await a.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await c.emulateMedia({ colorScheme: 'dark' });
  await a.emulateMedia({ colorScheme: 'dark' });

  // A mention for Carol: the speaker moves above the badge.
  await a.click('.guild-channel-link:has-text("general")');
  await a.waitForSelector('#dm-input');
  await a.click('#dm-input');
  await a.keyboard.type(`@${carol.name}`);
  await a.waitForSelector('.mention-suggestions, [role="listbox"]', { timeout: 5000 }).catch(() => {});
  await a.keyboard.press('Enter');
  await a.keyboard.type(' look');
  await a.keyboard.press('Enter');
  await c.waitForSelector('.rail-mention-badge', { timeout: 10000 });
  await c.waitForSelector(`${badge('Rail Voice')}.above`);
  await shot(c, '07-carol-mention-and-voice', railClip);
  console.log('mention badge: speaker above it');

  // Alice leaves: gone everywhere.
  await a.click('.voice-bar-leave');
  await a.waitForSelector(badge('Rail Voice'), { state: 'detached', timeout: 10000 });
  await c.waitForSelector(badge('Rail Voice'), { state: 'detached', timeout: 10000 });
  await d.waitForSelector(badge('Rail Voice'), { state: 'detached', timeout: 10000 });
  console.log('alice left: no speaker anywhere');
  console.log('OK');
} finally {
  await browser.close();
}
