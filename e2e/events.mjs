// Scheduled events in a real browser: Alice makes a guild with a voice channel and schedules a
// weekly game night there in the three-step editor (with a cover); Bob opens Calendar, then
// the Events tab, and RSVPs Going to this date (Alice's count goes up live). Alice makes an event somewhere
// else for one person, copies its link and posts it: Bob gets a card under the message, RSVPs from it (and
// is waitlisted: Alice already goes) and opens the event from it.
// Alice starts the game night: Bob's channel list shows it live under the voice channel; she
// ends it and it moves on to next week. She cancels the other: gone for Bob. Then a phone.
//   node e2e/serve.mjs &   then   node e2e/events.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE, send } from './helpers.mjs';

// Calendar in the channel list, then the dialog's Events tab (it opens on the calendar).
async function openList(page) {
  await page.click('.guild-events-button');
  await page.click('.events-dialog [role="tab"]:has-text("Events")');
}

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
};

// A date `days` from now as the date input wants it.
function dayFromNow(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A small PNG for the cover.
const COVER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAACACAIAAAD1bSf9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAADZklEQVR4nO3VUQ0DARAC0dM5ZmrxJNVDf0izL0HAZoDl6fMSAgj0n0V45hcQAgikwEKAQPf2wALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IARSYCFAoHvf0ALvPSAEUmAhQKB739AC7z0gBFJgIUCge9/QAu89IAQUWAgQeA8+Agu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBBIgYUAge59Qwu894AQSIGFAIHufUMLvPeAEEiBhQCB7n1DC7z3gBDo1xh8ATWEr4jmuRbTAAAAAElFTkSuQmCC',
  'base64'
);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Game Club');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('#dm-input');

  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.check('input[name="channel-type"][value="voice"]');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button[type="submit"]:has-text("Create channel")');
  await a.waitForSelector('.guild-channel-link:has-text("lounge")');
  check(await b.textContent('.guild-events-button') === 'Calendar', 'Calendar row');

  // The editor: where, what and when, review.
  await a.click('.guild-header-button');
  await a.click('.guild-menu-item:has-text("Create Event")');
  await a.waitForSelector('.event-editor');
  check(await a.isChecked('input[name="event-place"][value="voice"]'), 'voice channel picked first');
  await shot(a, 'editor-where');
  await a.click('.event-editor button:has-text("Next")');
  await a.fill('#event-name', 'Game night');
  await a.fill('#event-start-date', dayFromNow(2));
  await a.fill('#event-start-time', '20:00');
  await a.selectOption('#event-repeat', 'weekly');
  await a.fill('#event-description', 'Bring **snacks**');
  await a.setInputFiles('.event-editor input[type="file"]', { name: 'cover.png', mimeType: 'image/png', buffer: COVER });
  await a.waitForSelector('.event-editor .event-card-cover img');
  await shot(a, 'editor-info');
  await a.click('.event-editor button:has-text("Next")');
  await a.waitForSelector('.event-editor-review .event-card');
  check((await a.textContent('.event-editor-review')).includes('Weekly on'), 'review shows how it repeats');
  await shot(a, 'editor-review');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail');
  check((await a.textContent('.events-dialog .event-detail')).includes('Created by'), 'opens the new event');
  await shot(a, 'detail');
  await a.keyboard.press('Escape');

  // Bob: the event, RSVP.
  await openList(b);
  await b.waitForSelector('.events-dialog .event-card');
  await shot(b, 'list');
  // A weekly event: RSVP asks whether it's for this date or all of them, each a submenu.
  await b.click('.events-dialog .event-card .event-rsvp');
  await b.waitForSelector('[role="menuitem"]:has-text("All events")');
  await b.click('[role="menuitem"]:has-text("This event")');
  await b.waitForSelector('[role="menuitemradio"]:has-text("Going")');
  await shot(b, 'rsvp-menu');
  await b.click('[role="menuitemradio"]:has-text("Going")');
  check((await b.textContent('.events-dialog .event-card .event-rsvp')).trim() === 'Going', 'bob going to this one');
  await openList(a);
  await a.waitForFunction(() => document.querySelector('.events-dialog .event-card-count')?.textContent.includes('2 going'));
  console.log('ok: bob going, alice sees 2 live');
  await b.click('.events-dialog .event-card-name');
  await b.click('.events-dialog [role="tab"]:has-text("RSVPs")');
  await b.waitForFunction(() => document.querySelectorAll('.event-rsvp-group.going li').length === 2);
  await shot(b, 'rsvps');
  console.log('ok: who is going listed');
  await b.keyboard.press('Escape');

  // Somewhere else, then its link in #general.
  await a.click('.events-dialog button:has-text("Create Event")');
  await a.check('input[name="event-place"][value="external"]');
  await a.fill('#event-location', 'The park');
  await a.click('.event-editor button:has-text("Next")');
  await a.fill('#event-name', 'Picnic');
  await a.fill('#event-start-date', dayFromNow(3));
  await a.fill('#event-start-time', '12:00');
  await a.click('.event-editor button:has-text("Next")');
  check((await a.textContent('.event-editor [role="alert"]')).includes('end date'), 'somewhere else needs an end');
  await a.fill('#event-end-date', dayFromNow(3));
  await a.fill('#event-end-time', '15:00');
  // One place: Alice (who made it) is going, so the next one waits.
  await a.click('.event-editor label:has-text("Limit how many can go")');
  await a.fill('#event-limit', '1');
  await a.click('.event-editor button:has-text("Next")');
  check((await a.textContent('.event-editor-review .event-card-count')).includes('1 of 1 going'), 'review shows the limit');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail');
  await a.click('.events-dialog .event-more');
  await a.click('text=Copy Link');
  const eventUrl = await a.evaluate(() => navigator.clipboard.readText());
  check(/\/guild\/\d+\?event=\d+$/.test(eventUrl), `copied ${eventUrl}`);
  await a.keyboard.press('Escape');
  await a.keyboard.press('Escape');
  await a.click(".guild-channel-link:has-text(\"general\")");
  await send(a, `Who is coming? ${eventUrl}`);
  await b.waitForSelector('.event-embed .event-card:has-text("Picnic")');
  await b.click('.event-embed .event-rsvp');
  await b.click('[role="menuitemradio"]:has-text("Going")');
  await b.waitForSelector('.event-embed .event-rsvp:has-text("Waitlisted")');
  await b.waitForFunction(() => document.querySelector('.event-embed .event-card-count')?.textContent.includes('1 of 1 going · 1 on the waitlist'));
  await b.waitForTimeout(300); // the button's colour fading in
  await shot(b, 'embed');
  console.log('ok: going past the limit = waitlisted');
  await b.click('.event-embed button:has-text("View")');
  await b.waitForSelector('.events-dialog .event-detail:has-text("The park")');
  console.log('ok: link card opens the event');
  await b.click('.events-dialog [role="tab"]:has-text("RSVPs")');
  await b.waitForSelector('.event-rsvp-group.waitlisted li');
  // Alice can't go after all: Bob moves up, live.
  await openList(a);
  await a.click('.events-dialog .event-card:has-text("Picnic") .event-rsvp');
  await a.click('[role="menuitemradio"]:has-text("Can\'t go")');
  await b.waitForSelector('.event-rsvp-group.declined li');
  await b.waitForFunction(() => !document.querySelector('.event-rsvp-group.waitlisted'));
  check((await b.textContent('.events-dialog .event-rsvp')).trim() === 'Going', 'bob moved up off the waitlist');
  await shot(b, 'rsvps-moved-up');
  await a.keyboard.press('Escape');
  await b.keyboard.press('Escape');

  // Start, live in the channel list, end: next week.
  await openList(a);
  await a.click('.events-dialog .event-card:has-text("Game night") button:has-text("Start")');
  await b.waitForSelector('.guild-channel-event:has-text("Game night")');
  check((await b.textContent('.guild-live-events')).includes('Game night'), 'listed as on now under Calendar');
  await shot(b, 'live');
  const before = await a.textContent('.events-dialog .event-card:has-text("Game night") .event-card-when');
  await a.click('.events-dialog .event-card:has-text("Game night") button:has-text("End event")');
  await a.waitForFunction((was) => {
    const card = [...document.querySelectorAll('.events-dialog .event-card')].find((c) => c.textContent.includes('Game night'));
    return card && !card.textContent.includes('Happening now') && card.querySelector('.event-card-when').textContent !== was;
  }, before);
  await b.waitForFunction(() => !document.querySelector('.guild-channel-event'));
  console.log('ok: ended, moved on to', await a.textContent('.events-dialog .event-card:has-text("Game night") .event-card-when'));

  // Bob went to that one alone: no answer to next week's. Then going to all of them, then can't go
  // to this one.
  const night = '.events-dialog .event-card:has-text("Game night")';
  const countOf = (text) => a.waitForFunction((want) => [...document.querySelectorAll('.events-dialog .event-card')]
    .find((c) => c.textContent.includes('Game night'))?.querySelector('.event-card-count').textContent.trim().startsWith(want), text);
  await countOf('1 going');
  if (await b.$('.events-dialog .events-back')) await b.click('.events-dialog .events-back');
  if (await b.$('.events-dialog')) await b.click('.events-dialog [role="tab"]:has-text("Events")');
  else await openList(b);
  await b.waitForSelector(night);
  check((await b.textContent(`${night} .event-rsvp`)).trim() === 'RSVP', 'an answer to one date gone once it moved on');
  await b.click(`${night} .event-rsvp`);
  await b.click('[role="menuitem"]:has-text("All events")');
  await b.click('[role="menuitemradio"]:has-text("Going")');
  await countOf('2 going');
  await b.click(`${night} .event-rsvp`);
  await b.click('[role="menuitem"]:has-text("This event")');
  await b.click('[role="menuitemradio"]:has-text("Can\'t go")');
  await countOf('1 going');
  check((await b.textContent(`${night} .event-rsvp`)).trim() === "Can't go", "can't go to this one");
  await b.click(`${night} .event-rsvp`);
  await b.click('[role="menuitem"]:has-text("All events")');
  const ticked = await b.$$eval('[role="menuitemradio"][aria-checked="true"]', (items) => items.map((i) => i.textContent.trim()));
  check(ticked.join('|') === 'Going', `all events still going (${ticked.join(', ')})`);
  await b.keyboard.press('Escape');
  await b.keyboard.press('Escape');

  // Cancel the picnic.
  await a.click('.events-dialog .event-card:has-text("Picnic") .event-more');
  await a.click('[role="menuitem"]:has-text("Cancel event"), button:has-text("Cancel event")');
  await a.click('.vc-dialog .btn-danger:has-text("Cancel event")');
  await b.waitForSelector('.event-embed-gone, .event-embed:not(:has(.event-card))', { timeout: 5000 }).catch(() => {});
  console.log('ok: cancelled, gone for bob');

  // A phone.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const c = carol.page;
  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.click('button:has-text("Accept invite")');
  await c.waitForSelector('#dm-input');
  await c.waitForTimeout(800);
  // Slide back to the channel list.
  await c.goBack();
  await c.waitForTimeout(600);
  await shot(c, 'phone-channels');
  await c.waitForSelector('.guild-events-button', { timeout: 5000 });
  await openList(c);
  await c.waitForSelector('.events-dialog .event-card');
  const box = await c.locator('.events-dialog').boundingBox();
  const width = c.viewportSize().width;
  check(box.x >= 0 && box.x + box.width <= width + 1, 'dialog fits the phone');
  await shot(c, 'phone-list');
  // RSVP on a phone: the same choices as a sheet, the submenu replacing it.
  await c.click('.events-dialog .event-card .event-rsvp');
  await c.click('[role="menuitem"]:has-text("All events")');
  await c.waitForSelector('[role="menuitemradio"]:has-text("Maybe")');
  await c.waitForTimeout(500); // the sheet rising
  await shot(c, 'phone-rsvp-sheet');
  await c.click('[role="menuitemradio"]:has-text("Maybe")');
  check((await c.textContent('.events-dialog .event-card .event-rsvp')).trim() === 'Maybe', 'phone: maybe to all');
  await c.click('.events-dialog .event-card .event-rsvp');
  await c.click('[role="menuitem"]:has-text("All events")');
  await c.click('[role="menuitem"]:has-text("Remove my RSVP")');
  check((await c.textContent('.events-dialog .event-card .event-rsvp')).trim() === 'RSVP', 'phone: answer taken back');
  await c.click('.events-dialog .event-card-name');
  await c.waitForSelector('.events-dialog .event-detail');
  await shot(c, 'phone-detail');
  console.log('events: all good');
} finally {
  await browser.close();
}
