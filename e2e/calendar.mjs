// The events calendar in a real browser: Alice opens Calendar (first tab, open; the dialog is the same size on
// both tabs and on an event), makes a weekly event from the + on a day of the calendar (the
// editor starts on that day at 18:00), comes back to the calendar and finds it on that day
// and a week later; Bob's calendar gets it live; next month, Today; the Events tab's Create
// Event still works; an all-day event over three days with an emoji and a colour; an event starting
// by itself at its time, then listed under Calendar. Then a phone: dots in the squares, tap a day for its list, Create Event.
//   node e2e/serve.mjs &   then   node e2e/calendar.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
};
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysFromNow = (n) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
};
const size = async (page) => {
  const box = await page.locator('.events-dialog').boundingBox();
  return `${Math.round(box.width)}x${Math.round(box.height)}`;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1280, height: 860 } });
  const bob = await signUp(browser, 'bob', { viewport: { width: 1280, height: 860 } });
  const a = alice.page;
  const b = bob.page;

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

  // Calendar in the channel list opens on the calendar, the first tab; one size for both tabs.
  check(await a.textContent('.guild-events-button') === 'Calendar', 'Calendar in the channel list');
  await a.click('.guild-events-button');
  await a.waitForSelector('.event-calendar-grid');
  check(await a.locator('.events-dialog [role="tab"]').first().textContent() === 'Month', 'Month is the first tab');
  const listSize = await size(a);
  await a.click('.events-dialog [role="tab"]:has-text("Events")');
  await a.waitForSelector('.events-empty');
  check(await size(a) === listSize, `same size on both tabs (${listSize})`);
  await shot(a, 'list-empty');
  await a.click('.events-dialog [role="tab"]:has-text("Month")');
  check(await a.locator('.event-calendar-cell').count() === 42, 'six weeks of days');
  check(await a.locator('.event-calendar-cell.today').count() === 1, 'today marked');
  await shot(a, 'calendar-empty');

  // + on a day: the editor starts there at 18:00.
  const day = daysFromNow(4);
  if (key(day).slice(0, 7) !== key(new Date()).slice(0, 7) && !(await a.locator(`[data-day="${key(day)}"]`).count())) {
    await a.click('.event-calendar-nav[aria-label="Next month"]');
  }
  const cell = a.locator(`[data-day="${key(day)}"]`);
  await cell.hover();
  await cell.locator('.event-calendar-add').click();
  await a.waitForSelector('.event-editor');
  await a.check('input[name="event-place"][value="external"]');
  await a.fill('#event-location', 'The pub');
  await a.click('.event-editor button:has-text("Next")');
  check(await a.inputValue('#event-start-date') === key(day), 'editor starts on the day picked');
  check(await a.inputValue('#event-start-time') === '18:00', 'at 18:00');
  await a.fill('#event-name', 'Board games');
  await a.fill('#event-end-date', key(day));
  await a.fill('#event-end-time', '21:00');
  await a.selectOption('#event-repeat', 'weekly');
  await a.click('.event-editor button:has-text("Next")');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail');
  check(await size(a) === listSize, 'same size on an event');
  await shot(a, 'detail');
  check((await a.textContent('.events-dialog .events-back')).includes('Calendar'), 'back says Calendar');
  await a.click('.events-dialog .events-back');
  await a.waitForSelector('.event-calendar-grid');
  check(await a.locator(`[data-day="${key(day)}"] .event-calendar-chip:has-text("Board games")`).count() === 1, 'on the day');
  check((await a.textContent(`[data-day="${key(day)}"] .event-calendar-chip`)).trim() === 'Board games', 'the name, no time, in the square');
  const weekLater = daysFromNow(11);
  if (await a.locator(`[data-day="${key(weekLater)}"]`).count()) {
    check(await a.locator(`[data-day="${key(weekLater)}"] .event-calendar-chip:has-text("Board games")`).count() === 1, 'and a week later');
  }
  check((await a.textContent('.event-calendar-day')).includes('Board games'), "in the chosen day's list");
  await a.mouse.move(5, 5);
  await shot(a, 'calendar');

  // Bob's calendar, live; the chip opens it.
  await b.click('.guild-events-button');
  await b.click('.events-dialog [role="tab"]:has-text("Month")');
  if (!(await b.locator(`[data-day="${key(day)}"]`).count())) await b.click('.event-calendar-nav[aria-label="Next month"]');
  await b.waitForSelector(`[data-day="${key(day)}"] .event-calendar-chip:has-text("Board games")`);
  await b.click(`[data-day="${key(day)}"] .event-calendar-chip`);
  await b.waitForSelector('.events-dialog .event-detail:has-text("The pub")');
  console.log('ok: bob sees it on his calendar and opens it');
  await b.keyboard.press('Escape');

  // Next month and Today.
  const title = await a.textContent('.event-calendar-month');
  await a.click('.event-calendar-nav[aria-label="Next month"]');
  check(await a.textContent('.event-calendar-month') !== title, 'next month');
  check(await a.locator('.event-calendar-chip:has-text("Board games")').count() >= 4, 'repeats through the next month');
  await a.click('.event-calendar button:has-text("Today")');
  check(await a.locator('.event-calendar-cell.today.selected').count() === 1, 'Today goes back and picks today');

  // The Events tab's Create Event: cancel goes back to it.
  await a.click('.events-dialog [role="tab"]:has-text("Events")');
  await a.click('.events-dialog .vc-dialog-actions button:has-text("Create Event")');
  await a.waitForSelector('.event-editor');
  await a.click('.event-editor button:has-text("Cancel")');
  await a.waitForSelector('.events-dialog .event-card:has-text("Board games")');
  check(await a.locator('.events-dialog [role="tab"][aria-selected="true"]:has-text("Events")').count() === 1, 'cancel returns to the Events tab');

  // Again, somewhere else without saying where, moving by the steps at the top.
  await a.click('.events-dialog .vc-dialog-actions button:has-text("Create Event")');
  await a.check('input[name="event-place"][value="external"]');
  await a.click('.event-editor-steps button:has-text("Review")');
  check(await a.locator('#event-name').isVisible(), 'Review stops at Event info with nothing named');
  check((await a.textContent('.event-editor [role="alert"]')).includes('topic'), 'and says why');
  await a.fill('#event-name', 'Mystery meet-up');
  await a.fill('#event-start-date', key(daysFromNow(5)));
  await a.fill('#event-start-time', '12:00');
  await a.fill('#event-end-date', key(daysFromNow(5)));
  await a.fill('#event-end-time', '13:00');
  await shot(a, 'editor-steps');
  await a.click('.event-editor-steps button:has-text("Review")');
  await a.waitForSelector('.event-editor-review .event-card:has-text("Mystery meet-up")');
  check(await a.locator('.event-editor-review .fa-location-dot').count() === 0, 'no place line without a location');
  await a.click('.event-editor-steps button:has-text("Location")');
  check(await a.inputValue('#event-location') === '', 'Location step, still empty');
  await a.click('.event-editor-steps button:has-text("Review")');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail:has-text("Mystery meet-up")');
  console.log('ok: made without a location');
  await a.click('.events-dialog .events-back');
  await a.waitForSelector('.events-dialog .event-card:has-text("Mystery meet-up")');
  await shot(a, 'list');
  await a.keyboard.press('Escape');

  // All day over three days, with an emoji and a colour, from a day's +.
  await a.click('.guild-events-button');
  const first = daysFromNow(6);
  if (!(await a.locator(`[data-day="${key(first)}"]`).count())) await a.click('.event-calendar-nav[aria-label="Next month"]');
  await a.locator(`[data-day="${key(first)}"]`).hover();
  await a.locator(`[data-day="${key(first)}"] .event-calendar-add`).click();
  await a.check('input[name="event-place"][value="external"]');
  await a.click('.event-editor button:has-text("Next")');
  await a.fill('#event-name', 'Festival');
  await a.check('text=All day');
  check(!(await a.locator('#event-start-time').count()), 'all day: dates only');
  check(await a.inputValue('#event-end-date') === key(first), 'last day starts as the first');
  await a.fill('#event-end-date', key(daysFromNow(8)));
  await a.click('.event-editor button:has-text("Add an emoji")');
  await a.fill('.emoji-picker-search', 'tent');
  await a.click('.emoji-picker-item >> nth=0');
  await a.waitForSelector('.event-editor-emoji .event-emoji img');
  await a.click('.event-editor .role-color[aria-label="#e91e63"]');
  await shot(a, 'editor-all-day');
  await a.click('.event-editor-steps button:has-text("Review")');
  check(/–/.test(await a.textContent('.event-editor-review .event-card-when')), 'review shows its dates');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail:has-text("Festival")');
  await a.click('.events-dialog .events-back');
  await a.waitForSelector('.event-calendar-grid');
  for (const n of [6, 7, 8]) {
    const d = daysFromNow(n);
    if (!(await a.locator(`[data-day="${key(d)}"]`).count())) continue; // the page ends first
    const chip = a.locator(`[data-day="${key(d)}"] .event-calendar-chip.all-day:has-text("Festival")`);
    check(await chip.count() === 1, `all day on day ${n}`);
    check(await chip.locator('.event-emoji img').count() === 1, `with its emoji on day ${n}`);
    const background = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
    check(background !== 'rgba(0, 0, 0, 0)', `in its colour (${background})`);
  }
  check(!(await a.locator(`[data-day="${key(daysFromNow(9))}"] .event-calendar-chip:has-text("Festival")`).count()), 'not after its last day');
  await a.mouse.move(5, 5);
  await shot(a, 'calendar-all-day');
  await a.keyboard.press('Escape');

  // Starts by itself at its time: a minute or two from now, then listed under Calendar for both.
  const soon = new Date(Date.now() + 65 * 1000);
  soon.setSeconds(0, 0);
  soon.setMinutes(soon.getMinutes() + 1);
  await a.click('.guild-events-button');
  await a.click('.events-dialog [role="tab"]:has-text("Events")');
  await a.click('.events-dialog .vc-dialog-actions button:has-text("Create Event")');
  await a.check('input[name="event-place"][value="external"]');
  await a.click('.event-editor button:has-text("Next")');
  await a.fill('#event-name', 'Quick chat');
  await a.fill('#event-start-date', key(soon));
  await a.fill('#event-start-time', `${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
  const over = new Date(soon.getTime() + 3600 * 1000);
  await a.fill('#event-end-date', key(over));
  await a.fill('#event-end-time', `${pad(over.getHours())}:${pad(over.getMinutes())}`);
  await a.click('.event-editor-steps button:has-text("Review")');
  await a.click('.event-editor button:has-text("Create Event")');
  await a.waitForSelector('.events-dialog .event-detail:has-text("Quick chat")');
  await a.keyboard.press('Escape');
  check(!(await a.locator('.guild-live-event').count()), 'nothing on yet');
  const wait = soon.getTime() - Date.now() + 30 * 1000; // the server looks every 15 s
  await a.waitForSelector('.guild-live-event:has-text("Quick chat")', { timeout: wait });
  await b.waitForSelector('.guild-live-event:has-text("Quick chat")', { timeout: 5000 });
  console.log(`ok: started by itself ${Math.round((Date.now() - soon.getTime()) / 1000)} s after its time, listed for both`);
  await shot(a, 'happening-now');
  await a.click('.guild-live-event:has-text("Quick chat")');
  await a.waitForSelector('.events-dialog .event-detail:has-text("Happening now")');
  console.log('ok: a click opens it');
  await a.keyboard.press('Escape');

  // Dark.
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await a.click('.guild-events-button');
  await a.click('.events-dialog [role="tab"]:has-text("Month")');
  await shot(a, 'calendar-dark');
  await a.keyboard.press('Escape');

  // A phone.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const c = carol.page;
  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.click('button:has-text("Accept invite")');
  await c.waitForSelector('#dm-input');
  await c.waitForTimeout(800);
  await c.goBack();
  await c.waitForTimeout(600);
  await c.click('.guild-events-button');
  await c.click('.events-dialog [role="tab"]:has-text("Month")');
  await c.waitForSelector('.event-calendar-grid');
  const box = await c.locator('.events-dialog').boundingBox();
  const width = c.viewportSize().width;
  check(box.x >= 0 && box.x + box.width <= width + 1, 'dialog fits the phone');
  const overflow = await c.evaluate(() => {
    const grid = document.querySelector('.event-calendar-grid');
    return grid.scrollWidth - grid.clientWidth;
  });
  check(overflow <= 1, 'calendar fits across');
  if (!(await c.locator(`[data-day="${key(day)}"]`).count())) await c.click('.event-calendar-nav[aria-label="Next month"]');
  check(await c.locator(`[data-day="${key(day)}"] .event-calendar-dot`).count() === 1, 'a dot on the day');
  check(!(await c.locator('.event-calendar-chip').first().isVisible()), 'no names in the squares');
  const festivalDay = daysFromNow(6);
  if (await c.locator(`[data-day="${key(festivalDay)}"]`).count()) {
    check(await c.locator(`[data-day="${key(festivalDay)}"] .event-calendar-dots .event-emoji img`).count() === 1, "an emoji instead of a dot for one that has it");
  }
  await c.tap(`[data-day="${key(day)}"] .event-calendar-date`);
  await c.waitForSelector('.event-calendar-day:has-text("Board games")');
  await shot(c, 'phone-calendar');
  await c.click('.event-calendar-day .event-calendar-day-event');
  await c.waitForSelector('.events-dialog .event-detail');
  check(await size(c) === `${Math.round(box.width)}x${Math.round(box.height)}`, 'same size on an event (phone)');
  await shot(c, 'phone-detail');
  console.log('calendar: all good');
} finally {
  await browser.close();
}
