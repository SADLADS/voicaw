// Links to the app's own pages: an event's Copy Link gives this site's address, the link in a
// DM gets the event's card (Settings → Privacy off: it waits for Show), and tapping the link on
// a phone opens the event in the same page (no new tab); other sites' links still open a new tab.
// (Copy Link from the desktop and Android apps, whose own addresses only open inside them, is
// covered by client/src/utils/guildDisplay.test.js: here the API's address is the page's own.)
//   node e2e/serve.mjs &   then   node e2e/applinks.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/applinks-${name}.png` }) : null);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const dayFromNow = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await makeFriends(alice, bob);
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  // A guild with Bob in it, and an event somewhere else.
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Picnic Club');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const invite = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(invite.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');

  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Create Event")');
  await a.check('input[name="event-place"][value="external"]');
  await a.fill('#event-location', 'The park');
  await a.click('.event-editor button:has-text("Next")');
  await a.fill('#event-name', 'Picnic');
  await a.fill('#event-start-date', dayFromNow(3));
  await a.fill('#event-start-time', '12:00');
  await a.fill('#event-end-date', dayFromNow(3));
  await a.fill('#event-end-time', '15:00');
  await a.click('.event-editor button:has-text("Next")');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail');
  await a.click('.events-dialog .event-more');
  await a.click('text=Copy Link');
  const eventUrl = await a.evaluate(() => navigator.clipboard.readText());
  check(eventUrl.startsWith(`${BASE}/guild/`) && /\?event=\d+$/.test(eventUrl), `Copy Link gives this site's address (${eventUrl})`);
  await a.keyboard.press('Escape');
  await a.keyboard.press('Escape');

  // In a DM: the event's card, on Bob's phone.
  await openChat(a, bob.id);
  await send(a, `Coming? ${eventUrl} or see https://example.com/`);
  await openChat(b, alice.id);
  await b.waitForSelector('.event-embed .event-card:has-text("Picnic")', { timeout: 15000 });
  check(true, 'the event gets its card in a DM');
  await shot(b, 'dm-card');

  // Tapping the link opens the event here, not in a new tab.
  const pagesBefore = b.context().pages().length;
  await b.tap(`.message a[href="${eventUrl}"]`);
  await b.waitForSelector('.events-dialog .event-detail:has-text("The park")', { timeout: 10000 });
  check(new URL(b.url()).pathname.startsWith('/guild/'), `opens the guild in the same page (${b.url()})`);
  check(b.context().pages().length === pagesBefore, 'no new tab');
  await shot(b, 'opened');

  // Other sites' links keep opening a new tab.
  await openChat(b, alice.id);
  check(await b.getAttribute('a[href="https://example.com/"]', 'target') === '_blank', "another site's link still opens a new tab");

  // Settings → Privacy off: the card waits for Show.
  await b.evaluate(() => localStorage.setItem('privacy', JSON.stringify({ inviteEmbedsInEncrypted: false })));
  await b.reload();
  await b.waitForSelector('.event-embed-hidden', { timeout: 15000 });
  check(await b.locator('.event-embed .event-card').count() === 0, 'with the setting off, the card waits');
  await shot(b, 'hidden');
  await b.tap('.event-embed-hidden button:has-text("Show")');
  await b.waitForSelector('.event-embed .event-card:has-text("Picnic")');
  check(true, 'Show loads it');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
