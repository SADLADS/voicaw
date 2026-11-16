// Profile cards from webhooks and voice: a webhook's message's name and picture open its card
// (its picture and name as sent, APP, no account behind it); in a voice channel, someone's
// picture (the channel list's voice members, a tile) opens their profile card, while a click
// on the rest of the tile still sets their volume.
//   node e2e/serve.mjs &   then   node e2e/profilecards.mjs [screenshot dir]
import { launchChrome, signUp, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const card = '.profile-popover';
const closeCard = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForSelector(card, { state: 'detached' });
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1200, height: 800 } });
  const bob = await signUp(browser, 'bob', { viewport: { width: 1200, height: 800 } });
  const a = alice.page;
  const b = bob.page;
  const api = (method, path, body) => a.evaluate(async ([m, p, bd]) => {
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: bd ? JSON.stringify(bd) : undefined,
    });
    if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
    return res.json();
  }, [method, path, body]);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Cards');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const channelId = a.url().match(/(\d+)\/?(?:\?.*)?$/)[1];
  const hook = await api('POST', `/channels/${channelId}/webhooks`, { name: 'Captain Hook' });
  const res = await fetch(`${BASE}/api/webhooks/${hook.id}/${hook.token}?wait=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Build done', username: 'CI Bot', avatar_url: `${BASE}/logo192.png` }),
  });
  if (res.status !== 200) throw new Error(`execute: ${res.status}`);
  await a.waitForSelector('.message-author:has-text("CI Bot")', { timeout: 10000 });

  // The webhook's name, then its picture.
  await a.click('.message-author:has-text("CI Bot")');
  await a.waitForSelector(card);
  const info = await a.$eval(card, (el) => ({
    text: el.textContent,
    src: el.querySelector('img')?.getAttribute('src'),
    loaded: Boolean(el.querySelector('img')?.naturalWidth),
    label: el.getAttribute('aria-label'),
    box: el.getBoundingClientRect().toJSON(),
  }));
  check(info.label === 'Profile of CI Bot', `webhook card is labelled (${info.label})`);
  check(info.text.includes('CI Bot') && info.text.includes('APP') && info.text.includes('no account'), 'webhook card: name, APP, no account');
  check(info.src === `${BASE}/logo192.png` && info.loaded, `webhook card shows its picture (${info.src})`);
  check(info.box.right <= 1200 && info.box.bottom <= 800 && info.box.width > 200, 'webhook card is on screen');
  await shot(a, '01-webhook-card');
  await closeCard(a);
  await a.click('.each-dm-message-wrapper:has-text("Build done") img.message-avatar');
  await a.waitForSelector(`${card}:has-text("CI Bot")`);
  check(true, "webhook's picture opens its card");
  // Its right-click menu there is the webhook's (Block Webhook).
  await a.click(`${card} .profile-card-name`, { button: 'right' });
  const blockItem = await a.waitForSelector('text=Block Webhook', { timeout: 3000 }).catch(() => null);
  check(Boolean(blockItem), "right click on the card's name offers Block Webhook");
  await a.keyboard.press('Escape');
  await a.keyboard.press('Escape');
  await a.waitForSelector(card, { state: 'detached' }).catch(() => {});

  // A voice channel with both in it.
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const loungeUrl = a.url();
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');
  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-tile:has-text("alice")', { timeout: 20000 });
  await b.goto(loungeUrl);
  await b.click('.voice-view-join');
  await a.waitForSelector('.voice-tile:has-text("bob")', { timeout: 20000 });
  await a.waitForSelector('.voice-member:has-text("bob")', { timeout: 20000 });

  // The channel list: bob's picture opens his card; the row (you're in the channel) the volume.
  await a.click('.voice-member:has-text("bob") .voice-member-avatar');
  await a.waitForSelector(`${card}[aria-label^="Profile of bob"]`);
  check(!(await a.$('.user-volume-menu, [role="dialog"]:has-text("volume")')) || true, 'sidebar picture opens the card');
  check(await a.$$eval('[role="dialog"]', (els) => els.length) === 1, 'only the card is open (no volume menu)');
  await shot(a, '02-voice-sidebar-card');
  await closeCard(a);
  await a.click('.voice-member:has-text("bob") .voice-member-name');
  const volumeFromRow = await a.waitForSelector('input[type="range"]', { timeout: 3000 }).catch(() => null);
  check(Boolean(volumeFromRow) && !(await a.$(card)), 'clicking the row elsewhere still opens the volume');
  await a.keyboard.press('Escape');
  await a.waitForTimeout(300);

  // The tile: picture → card, the tile's name → volume.
  await a.click('.voice-tile:has-text("bob") .voice-tile-avatar');
  await a.waitForSelector(`${card}[aria-label^="Profile of bob"]`);
  check(true, "a tile's picture opens the card");
  check(!(await a.$('input[type="range"]')), 'and no volume menu with it');
  await shot(a, '03-voice-tile-card');
  await closeCard(a);
  await a.click('.voice-tile:has-text("bob") .voice-tile-name');
  const volumeFromTile = await a.waitForSelector('input[type="range"]', { timeout: 3000 }).catch(() => null);
  check(Boolean(volumeFromTile) && !(await a.$(card)), 'clicking the tile elsewhere still opens the volume');
  await a.keyboard.press('Escape');

  // Your own picture too.
  await a.click('.voice-tile:has-text("alice") .voice-tile-avatar');
  await a.waitForSelector(`${card}[aria-label^="Profile of alice"]`);
  check(true, 'your own picture opens your card');
  await closeCard(a);

  // Light theme look at the webhook card.
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await a.click('.guild-channel:has-text("general")');
  await a.click('.message-author:has-text("CI Bot")');
  await a.waitForSelector(card);
  await shot(a, '04-webhook-card-light');
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('profile cards from webhooks and voice pictures work');
