// The events calendar in a real browser: Alice opens Events (the dialog is the same size on
// both tabs and on an event), makes a weekly event from the + on a day of the calendar (the
// editor starts on that day at 18:00), comes back to the calendar and finds it on that day
// and a week later; Bob's calendar gets it live; next month, Today; the Events tab's Create
// Event still works. Then a phone: dots in the squares, tap a day for its list, Create Event.
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

  // One size for both tabs.
  await a.click('.guild-events-button');
  await a.waitForSelector('.events-dialog [role="tab"]:has-text("Calendar")');
  const listSize = await size(a);
  await shot(a, 'list-empty');
  await a.click('.events-dialog [role="tab"]:has-text("Calendar")');
  await a.waitForSelector('.event-calendar-grid');
  check(await size(a) === listSize, `same size on both tabs (${listSize})`);
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
  const weekLater = daysFromNow(11);
  if (await a.locator(`[data-day="${key(weekLater)}"]`).count()) {
    check(await a.locator(`[data-day="${key(weekLater)}"] .event-calendar-chip:has-text("Board games")`).count() === 1, 'and a week later');
  }
  check((await a.textContent('.event-calendar-day')).includes('Board games'), "in the chosen day's list");
  await a.mouse.move(5, 5);
  await shot(a, 'calendar');

  // Bob's calendar, live; the chip opens it.
  await b.click('.guild-events-button');
  await b.click('.events-dialog [role="tab"]:has-text("Calendar")');
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

  // The Events tab's Create Event, and back to it.
  await a.click('.events-dialog [role="tab"]:has-text("Events")');
  await a.click('.events-dialog .vc-dialog-actions button:has-text("Create Event")');
  await a.waitForSelector('.event-editor');
  await a.click('.event-editor button:has-text("Cancel")');
  await a.waitForSelector('.events-dialog .event-card:has-text("Board games")');
  check(await a.locator('.events-dialog [role="tab"][aria-selected="true"]:has-text("Events")').count() === 1, 'cancel returns to the Events tab');
  await shot(a, 'list');
  await a.keyboard.press('Escape');

  // Dark.
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await a.click('.guild-events-button');
  await a.click('.events-dialog [role="tab"]:has-text("Calendar")');
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
  await c.click('.events-dialog [role="tab"]:has-text("Calendar")');
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
