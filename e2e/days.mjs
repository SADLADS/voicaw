// Day dividers: a line with the date where a new day starts, and above the first message
// once there's no older history. Message times come from the server, so the history response
// is shifted back by days on the way in. Desktop and phone.
//   node e2e/serve.mjs &   then   node e2e/days.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
const DAY = 86400;
// How many days back each of the five messages is shown.
const SHIFT = [2, 2, 1, 0, 0];

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 750 }, locale: 'en-GB' });
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'], locale: 'en-GB' });
  await openChat(alice.page, bob.id);
  for (let i = 0; i < SHIFT.length; i++) await send(alice.page, `message ${i}`);
  await alice.page.waitForSelector('text=message 4');

  const shift = async (route) => {
    const res = await route.fetch();
    const rows = await res.json();
    rows.forEach((row, i) => { row.timestamp -= (SHIFT[i] ?? 0) * DAY; });
    await route.fulfill({ response: res, json: rows });
  };
  for (const { page } of [alice, bob]) await page.route('**/api/dm-messages/*', shift);

  await alice.page.reload();
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  for (const [who, page] of [['desktop', alice.page], ['phone', bob.page]]) {
    await page.waitForSelector('text=message 4');
    const labels = await page.$$eval('.day-divider', (els) => els.map((el) => el.textContent));
    const expected = [2, 1, 0].map((d) => new Date((Date.now() / 1000 - d * DAY) * 1000)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
    if (JSON.stringify(labels) !== JSON.stringify(expected)) {
      throw new Error(`${who}: dividers ${JSON.stringify(labels)}, expected ${JSON.stringify(expected)}`);
    }
    // Each divider sits right above the first message of its day.
    const above = await page.$$eval('.day-divider', (els) =>
      els.map((el) => el.parentElement.textContent.match(/message \d/)?.[0]));
    if (JSON.stringify(above) !== JSON.stringify(['message 0', 'message 2', 'message 3'])) {
      throw new Error(`${who}: dividers above ${JSON.stringify(above)}`);
    }
    if (dir) await page.screenshot({ path: `${dir}/days-${who}.png` });
  }

  // A message sent now joins today: no new divider.
  await send(alice.page, 'message 5');
  await alice.page.waitForSelector('text=message 5');
  if ((await alice.page.$$('.day-divider')).length !== 3) throw new Error('new message added a divider');
  console.log('days: ok (dividers between days and above the first message, desktop and phone)');
} catch (err) {
  console.error('days: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
