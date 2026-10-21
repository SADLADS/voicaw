// Single dates of a repeating event in a real browser: Alice has a weekly game night (and a quiz
// that took place today). On the calendar the quiz is greyed and opens as Ended; each date of
// the game night opens that date (its next dates listed, the one shown marked). She copies the
// link to the second date (&on=), renames that date alone, cancels the third ("this event"),
// and changes the fourth "and following" (a new event from then on). Bob opens the copied link:
// that date, its own name; he's interested in it alone, not the first. Then the link on a phone.
//   node e2e/serve.mjs &   then   node e2e/occurrences.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
};

// The API as the page's user.
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}, [method, path, body]);

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The weekly event's dates: tomorrow at 19:00 here, then a week on each time (the wall clock).
const dates = [1, 8, 15, 22, 29].map((days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(19, 0, 0, 0);
  return d;
});
const unix = (d) => Math.floor(d.getTime() / 1000);

// The calendar's square for a date (moving on a month if it isn't on the page).
async function cell(page, date) {
  const selector = `.event-calendar-cell[data-day="${key(date)}"]:not(.other-month)`;
  if (!(await page.locator(selector).count())) await page.click('.event-calendar-toolbar button:has-text("Today")');
  for (let i = 0; i < 3 && !(await page.locator(selector).count()); i++) await page.click('.event-calendar-nav[aria-label="Next month"]');
  return page.locator(selector);
}
const chipNames = async (page, date) => (await (await cell(page, date)).locator('.event-calendar-chip').allTextContents()).map((s) => s.trim());

async function openCalendar(page) {
  if (!(await page.locator('.events-dialog').count())) await page.click('.guild-events-button');
  await page.waitForSelector('.event-calendar-grid');
}
async function backToCalendar(page) {
  await page.click('.events-back');
  await page.waitForSelector('.event-calendar-grid');
  await page.click('.event-calendar-toolbar button:has-text("Today")');
}
async function openDate(page, date, name) {
  await (await cell(page, date)).locator(`.event-calendar-chip:has-text("${name}")`).first().click();
  await page.waitForSelector('.event-detail');
}
async function menu(page, item) {
  await page.click('.event-detail-buttons .event-more');
  await page.click(`[role="menuitem"]:has-text("${item}")`);
}
async function scope(page, label, button) {
  await page.waitForSelector('.event-scope-dialog');
  await page.check(`.event-scope-dialog label:has-text("${label}") input`);
  await page.click(`.event-scope-dialog button:has-text("${button}")`);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  const guild = await api(a, 'POST', '/guilds', { name: 'Game Club' });
  const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`);
  await api(b, 'POST', `/invites/${invite.code}`);
  const zone = await a.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const weekday = (dates[0].getDay() + 6) % 7;
  const night = await api(a, 'POST', `/guilds/${guild.id}/events`, {
    name: 'Game night', entityType: 'external', location: 'The pub', startTime: unix(dates[0]), endTime: unix(dates[0]) + 7200,
    recurrence: { frequency: 2, interval: 1, by_weekday: [weekday] }, timezone: zone,
  });
  // A quiz that took place today: started by hand, then ended.
  const quiz = await api(a, 'POST', `/guilds/${guild.id}/events`, {
    name: 'Quiz', entityType: 'external', location: 'Online', startTime: unix(new Date()) + 3600, endTime: unix(new Date()) + 7200,
  });
  await api(a, 'POST', `/guild-events/${quiz.id}/start`);
  await api(a, 'POST', `/guild-events/${quiz.id}/end`);
  await a.goto(`${BASE}/guild/${guild.id}`);
  await a.waitForSelector('#dm-input');

  // What took place: greyed, and it opens as Ended with how many were interested.
  await openCalendar(a);
  const today = new Date();
  const past = (await cell(a, today)).locator('.event-calendar-chip:has-text("Quiz")');
  check(await past.evaluate((el) => el.classList.contains('past') && Number(getComputedStyle(el).opacity) < 1), 'the quiz that took place is greyed');
  await shot(a, 'calendar-past');
  await past.click();
  await a.waitForSelector('.event-detail.past');
  check((await a.textContent('.event-detail .event-card-status')) === 'Ended', 'it opens as Ended');
  check(!(await a.locator('.event-detail .event-interest').count()), 'no Interested on it');
  await backToCalendar(a);

  // Each date of the game night opens that date.
  await openDate(a, dates[1], 'Game night');
  const listed = await a.locator('.event-detail-date').allTextContents();
  check(listed.length === 5, `its next dates listed (${listed.length})`);
  check((await a.getAttribute('.event-detail-date >> nth=1', 'aria-current')) === 'date', 'the second date is the one shown');
  await shot(a, 'second-date');

  // The link to this date.
  await menu(a, 'Copy link to this date');
  const link = await a.evaluate(() => navigator.clipboard.readText());
  check(link.endsWith(`/guild/${guild.id}?event=${night.id}&on=${key(dates[1])}`), `link to this date: ${link}`);
  await menu(a, 'Copy link to the series');
  check((await a.evaluate(() => navigator.clipboard.readText())).endsWith(`?event=${night.id}`), 'link to the series has no date');

  // Rename this date alone.
  await menu(a, 'Edit event');
  await scope(a, 'This event', 'Continue');
  await a.waitForSelector('.vc-dialog[aria-label="Edit this event"]');
  await shot(a, 'edit-this-event');
  await a.fill('#occurrence-name', 'Late game night');
  await a.click('button[type="submit"]:has-text("Save")');
  await a.waitForSelector('.event-detail-name:has-text("Late game night")');
  check(true, 'that date has its own name');
  await backToCalendar(a);
  check((await chipNames(a, dates[1])).includes('Late game night'), 'the calendar shows it on that date');
  check((await chipNames(a, dates[0])).includes('Game night') && !(await chipNames(a, dates[0])).includes('Late game night'), 'the others keep the series\' name');

  // Cancel the third date alone.
  await openDate(a, dates[2], 'Game night');
  await menu(a, 'Cancel event');
  await shot(a, 'cancel-scope');
  await scope(a, 'This event', 'Cancel events');
  await a.waitForSelector('.event-detail');
  await backToCalendar(a);
  check(!(await chipNames(a, dates[2])).some((n) => n.includes('Game night')), 'the third date is gone');
  check((await chipNames(a, dates[3])).includes('Game night'), 'the fourth is still there');

  // The fourth and following: a new topic from then on.
  await openDate(a, dates[3], 'Game night');
  await menu(a, 'Edit event');
  await scope(a, 'This and following events', 'Continue');
  await a.waitForSelector('.vc-dialog[aria-label="Edit this and following events"]');
  await a.click('.event-editor button:has-text("Next")');
  check(await a.isVisible('text=and every date after it change'), 'the editor says which dates change');
  await a.fill('#event-name', 'Board games');
  await a.click('.event-editor button:has-text("Next")');
  await a.click('.event-editor button:has-text("Save")');
  await a.waitForSelector('.event-detail-name:has-text("Board games")');
  await backToCalendar(a);
  check((await chipNames(a, dates[3])).includes('Board games') && (await chipNames(a, dates[4])).includes('Board games'), 'from the fourth on: Board games');
  check((await chipNames(a, dates[0])).includes('Game night'), 'before it: still Game night');
  const events = await api(a, 'GET', `/guilds/${guild.id}/events`);
  check(events.find((e) => e.id === night.id)?.until === unix(dates[3]), 'the old series ends at the fourth date');
  await a.keyboard.press('Escape');

  // Bob opens the copied link: that date, with its own name.
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.waitForSelector('.event-detail-name:has-text("Late game night")');
  check(true, 'the link opens that date');
  check(!(await b.url()).includes('event='), 'the link leaves the address');
  await b.click('.event-detail-buttons .event-interest');
  const choices = await b.locator('[role="menuitem"]').allTextContents();
  check(choices.join() === 'Interested in this event,Interested in all events', `Bob's choices: ${choices.join(', ')}`);
  await b.click('[role="menuitem"]:has-text("Interested in this event")');
  await b.waitForSelector('.event-detail-buttons .event-interest[aria-pressed="true"]');
  await b.waitForSelector('.settings-tab:has-text("2 interested")');
  check(true, 'interested in that date alone (2 interested)');
  await b.click('.event-detail-date >> nth=0');
  await b.waitForSelector('.event-detail-date[aria-current="date"] >> nth=0');
  check((await b.getAttribute('.event-detail-buttons .event-interest', 'aria-pressed')) === 'false', 'not in the first date');
  await shot(b, 'bob-first-date');

  // A phone opens the link too.
  const phone = await browser.newContext(devices['Pixel 7']);
  const p = await phone.newPage();
  await p.goto(`${BASE}/`);
  await p.evaluate((token) => localStorage.setItem('token', token), await b.evaluate(() => localStorage.getItem('token')));
  await p.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await p.waitForSelector('.event-detail-name:has-text("Late game night")', { timeout: 20000 });
  const fits = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(fits, 'phone: the date opens and fits');
  await shot(p, 'phone-date');

  console.log('occurrences: all good');
} finally {
  await browser.close();
}
