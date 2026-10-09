// The events calendar's Week tab in a real browser: Alice opens Week (tabs Month, Week,
// Events), goes to next week, makes events by clicking hours (the editor starts at that hour):
// two that overlap (side by side), one past midnight (split over two days), an all-day one
// along the top; the hours scroll inside the dialog (the days' header stays), the morning first;
// a block opens its event; Bob's week gets them live; Today and the line for now; Month follows
// the week; dark; then a phone.
//   node e2e/serve.mjs &   then   node e2e/calendarweek.mjs [screenshot dir]
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
const HOUR = 44;

// Next week's Monday + `n` days.
function nextWeek(n) {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 7);
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n);
}

// Click an hour of a day column (0 = Monday) of the week shown.
async function clickHour(page, column, hour) {
  await page.evaluate((top) => { document.querySelector('.event-week-scroll').scrollTop = top; }, Math.max(0, (hour - 1) * HOUR));
  // At its right edge, kept clear of events.
  const col = page.locator('.event-week-column').nth(column);
  const { width } = await col.boundingBox();
  await col.click({ position: { x: width - 3, y: hour * HOUR + 10 } });
  await page.waitForSelector('.event-editor');
}

// The editor from a clicked hour: somewhere else, then the name and end; Create.
async function makeEvent(page, { name, endDate, endTime, allDay = false, colour = false }) {
  await page.check('input[name="event-place"][value="external"]');
  await page.fill('#event-location', 'The club');
  await page.click('.event-editor button:has-text("Next")');
  await page.fill('#event-name', name);
  if (allDay) await page.check('.event-editor-check input');
  await page.fill('#event-end-date', endDate);
  if (endTime) await page.fill('#event-end-time', endTime);
  if (colour) await page.click('.event-editor-colours [role="radio"]:nth-child(3)');
  await page.click('.event-editor button:has-text("Next")');
  await page.click('.event-editor button:has-text("Create Event")');
  await page.waitForSelector('.events-dialog .event-detail');
  await page.click('.events-dialog .events-back');
  await page.waitForSelector('.event-week-grid');
}

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

  await a.click('.guild-events-button');
  await a.waitForSelector('.event-calendar-grid');
  const tabs = await a.locator('.events-dialog [role="tab"]').allTextContents();
  check(tabs.join() === 'Month,Week,Events', `tabs ${tabs.join(', ')}`);
  const monthSize = await a.locator('.events-dialog').boundingBox();
  await a.click('.events-dialog [role="tab"]:has-text("Week")');
  await a.waitForSelector('.event-week-grid');
  const weekSize = await a.locator('.events-dialog').boundingBox();
  check(Math.round(weekSize.height) === Math.round(monthSize.height), 'same dialog size as the month');
  check(await a.locator('.event-week-day').count() === 7, 'seven days');
  check(await a.locator('.event-week-day.today').count() === 1, 'today marked');
  check(await a.locator('.event-week-now').count() === 1, 'a line for now');
  const scrollTop = await a.evaluate(() => document.querySelector('.event-week-scroll').scrollTop);
  check(Math.abs(scrollTop - (8 * HOUR - 8)) < 2, `opens on the morning (${scrollTop})`);
  await shot(a, 'week-empty');

  // Next week: every hour is still to come.
  await a.click('.event-calendar-nav[aria-label="Next week"]');
  check(await a.locator('.event-week-day.today').count() === 0, 'next week');
  check(await a.locator('.event-week-day').first().getAttribute('aria-label') !== null, 'days labelled');

  // Monday 18:00–21:00 and 19:00–20:00: side by side.
  await clickHour(a, 0, 18);
  await a.check('input[name="event-place"][value="external"]');
  await a.fill('#event-location', 'The club');
  await a.click('.event-editor button:has-text("Next")');
  check(await a.inputValue('#event-start-date') === key(nextWeek(0)), 'editor starts on the day clicked');
  check(await a.inputValue('#event-start-time') === '18:00', 'at the hour clicked');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.event-week-grid');
  check(await a.locator('.events-dialog [role="tab"][aria-selected="true"]:has-text("Week")').count() === 1, 'cancel returns to the week');

  await clickHour(a, 0, 18);
  await makeEvent(a, { name: 'Board games', endDate: key(nextWeek(0)), endTime: '21:00' });
  await clickHour(a, 0, 19);
  await makeEvent(a, { name: 'Quiz', endDate: key(nextWeek(0)), endTime: '20:00', colour: true });
  // Friday 22:00 to Saturday 02:00.
  await clickHour(a, 4, 22);
  await makeEvent(a, { name: 'Late stream', endDate: key(nextWeek(5)), endTime: '02:00' });
  // Wednesday and Thursday, all day.
  await clickHour(a, 2, 10);
  await makeEvent(a, { name: 'Festival', endDate: key(nextWeek(3)), allDay: true });

  const box = async (name, nth = 0) => a.locator(`.event-week-block:has-text("${name}")`).nth(nth).boundingBox();
  const board = await box('Board games');
  const quiz = await box('Quiz');
  check(Math.abs(board.height - 3 * HOUR) < 4, `three hours tall (${board.height})`);
  check(Math.abs(quiz.y - board.y - HOUR) < 2, 'an hour lower');
  check(quiz.x >= board.x + board.width - 1, 'beside it, not over it');
  check(Math.abs(board.width - quiz.width) < 2, 'sharing the day');
  check(await a.locator('.event-week-block:has-text("Late stream")').count() === 2, 'past midnight: on both days');
  const [late1, late2] = [await box('Late stream'), await box('Late stream', 1)];
  check(late2.x > late1.x, 'the next day');
  check(Math.abs(late1.height - 2 * HOUR) < 4 && Math.abs(late2.height - 2 * HOUR) < 4, 'two hours each side of midnight');
  check(await a.locator('.event-week-all-day .event-calendar-chip:has-text("Festival")').count() === 2, 'all day, along the top of both days');
  check(await a.locator('.event-week-block:has-text("Festival")').count() === 0, 'not among the hours');

  // The header stays while the hours scroll; columns line up with the header.
  await a.evaluate(() => { document.querySelector('.event-week-scroll').scrollTop = 99999; });
  const head = await a.locator('.event-week-day').nth(3).boundingBox();
  const col = await a.locator('.event-week-column').nth(3).boundingBox();
  check(Math.abs(head.x - col.x) < 1.5 && Math.abs(head.width - col.width) < 1.5, `columns line up (${head.x}/${col.x}, ${head.width}/${col.width})`);
  check(await a.locator('.event-week-day').first().isVisible(), 'the days stay at the top');
  const scrolled = await a.evaluate(() => {
    const el = document.querySelector('.event-week-scroll');
    return { top: el.scrollTop, body: document.querySelector('.vc-dialog-body').scrollHeight - document.querySelector('.vc-dialog-body').clientHeight };
  });
  check(scrolled.top > 0 && scrolled.body <= 1, 'the hours scroll, not the dialog');
  await a.evaluate(() => { document.querySelector('.event-week-scroll').scrollTop = 17 * 44; });
  await a.mouse.move(5, 5);
  await shot(a, 'week');

  // A block opens its event.
  await a.click('.event-week-block:has-text("Quiz")');
  await a.waitForSelector('.events-dialog .event-detail:has-text("Quiz")');
  check((await a.textContent('.events-dialog .events-back')).includes('Calendar'), 'back says Calendar');
  await a.click('.events-dialog .events-back');
  await a.waitForSelector('.event-week-grid');
  check(await a.locator('.event-week-day.selected').first().getAttribute('aria-label') !== null, 'back on the week');

  // Month follows the week.
  await a.click('.events-dialog [role="tab"]:has-text("Month")');
  check(await a.locator(`.event-calendar-cell.selected[data-day="${key(nextWeek(0))}"]`).count() === 1, 'Month is on that week');
  await a.click('.events-dialog [role="tab"]:has-text("Week")');
  await a.click('.event-week button:has-text("Today")');
  check(await a.locator('.event-week-day.today.selected').count() === 1, 'Today goes back to this week');

  // Bob, live.
  await b.click('.guild-events-button');
  await b.click('.events-dialog [role="tab"]:has-text("Week")');
  await b.click('.event-calendar-nav[aria-label="Next week"]');
  await b.waitForSelector('.event-week-block:has-text("Board games")');
  check(await b.locator('.event-week-block').count() === 4, 'bob sees them');
  check(await b.locator('.event-week-column.can-create').count() === 7, 'bob may make events (a default): every day of next week clickable');
  await b.keyboard.press('Escape');

  // Dark.
  await a.click('.event-calendar-nav[aria-label="Next week"]');
  await a.emulateMedia({ colorScheme: 'dark' });
  await a.evaluate(() => { document.querySelector('.event-week-scroll').scrollTop = 17 * 44; });
  await shot(a, 'week-dark');
  await a.emulateMedia({ colorScheme: 'light' });

  // A phone.
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const p = carol.page;
  await p.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await p.click('button:has-text("Accept invite")');
  await p.waitForSelector('#dm-input');
  await p.waitForTimeout(800);
  await p.goBack();
  await p.waitForTimeout(600);
  await p.click('.guild-events-button');
  await p.click('.events-dialog [role="tab"]:has-text("Week")');
  await p.click('.event-calendar-nav[aria-label="Next week"]');
  await p.waitForSelector('.event-week-block:has-text("Board games")');
  const fits = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(fits, 'no sideways scrolling on a phone');
  const pcol = await p.locator('.event-week-column').first().boundingBox();
  check(pcol.width > 30, `columns ${Math.round(pcol.width)} px wide`);
  await p.evaluate(() => { document.querySelector('.event-week-scroll').scrollTop = 17 * 44; });
  await shot(p, 'week-phone');
  console.log('all good');
} finally {
  await browser.close();
}
