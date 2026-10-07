// Encrypted group names in real browsers: Ann makes "Trip" with Bea and Cal; the API only ever
// returns it encrypted, yet the list and header show it (decrypted on each device). Bea is the
// desktop app (a stand-in bridge, as in desktop.mjs) and has never opened the group: her
// notification still says "Trip" with the message, from the keys her conversation list saved
// on the device. Cal renames it (a line in the timeline, live for the others); Ann adds Dan
// (a phone), who reads the new name but not the rename from before he was in; after the new
// key, Bea's notification has the new name. Reloading keeps it.
//   node e2e/serve.mjs &   then   node e2e/groupnames.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, devices, BASE, makeFriends } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

function fakeBridge() {
  const record = { notifications: [] };
  window.__desktop = { record };
  const on = () => () => () => {};
  window.voicawDesktop = {
    platform: 'linux',
    getInfo: async () => ({ version: '0.1.0', packaged: false }),
    notify: (n) => record.notifications.push(n),
    setUnread: () => {},
    getSettings: async () => ({ closeToTray: true, startAtLogin: false, shortcuts: { toggleMute: null, toggleDeafen: null } }),
    updateSettings: async () => ({ settings: {}, failedShortcuts: [] }),
    checkForUpdates: async () => 'unsupported',
    installUpdate: () => {},
    onNavigate: on(),
    onShortcut: on(),
    onUpdateReady: on(),
  };
}

async function sendText(page, text) {
  await page.click('#dm-input');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}
// (On a phone the list is behind the open chat: present, not visible.)
const listRow = (page, name) => page.waitForSelector(`.dm-group:has-text("${name}")`, { timeout: 20000, state: "attached" });
const openGroup = async (page, name) => {
  await page.goto(`${BASE}/dm`);
  const href = await (await listRow(page, name)).getAttribute('href');
  await page.goto(`${BASE}${href}`);
  await page.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
};
// What the API itself returns for the group (the list and the detail), as text.
const apiText = (page, groupId) => page.evaluate(async (id) => {
  const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
  const list = await (await fetch('/api/group-dms', { headers })).text();
  const detail = await (await fetch(`/api/group-dms/${id}`, { headers })).text();
  return list + detail;
}, groupId);
const notifications = (page) => page.evaluate(() => window.__desktop.record.notifications);
async function waitForNotification(page, count) {
  for (let i = 0; i < 100; i++) {
    const list = await notifications(page);
    if (list.length >= count) return list[count - 1];
    await page.waitForTimeout(100);
  }
  return null;
}

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const cal = await signUp(browser, 'cal');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  // Bea is the desktop app.
  const beaContext = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await beaContext.addInitScript(fakeBridge);
  const bea = await signUp(browser, 'bea').then(async (b) => {
    const page = await beaContext.newPage();
    await page.goto(`${BASE}/`);
    await page.fill('input[placeholder="Username"]', b.name);
    await page.fill('input[placeholder="Password"]', b.password);
    await page.press('input[placeholder="Password"]', 'Enter');
    await page.waitForSelector('#dm-main', { timeout: 20000 });
    await b.page.context().close();
    return { ...b, page };
  });
  const [a, b, c, d] = [ann.page, bea.page, cal.page, dan.page];
  // Groups are made from friends.
  await makeFriends(ann, bea, cal, dan);
  for (const [who, page] of [['ann', a], ['bea', b], ['cal', c], ['dan', d]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated|abort|Too Many/i.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
    page.on('response', (r) => {
      if (r.status() === 429 || r.status() === 403) console.log(`[${who}] ${r.status()} from ${r.url()}`);
    });
    page.on('pageerror', (e) => console.log(`[${who}] page error:`, e.message));
  }

  // Ann makes "Trip".
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupId = a.url().split('/dm/g/')[1];
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  check(await a.textContent('.group-dm-title') === 'Trip', 'ann: the header says "Trip" at once');
  const fromApi = await apiText(a, groupId);
  check(!fromApi.includes('Trip') && fromApi.includes('"name_version":1'), 'the API only returns the name encrypted');

  // Bea (desktop app) never opens the group: her list reads the name and saves the keys.
  await b.goto(`${BASE}/settings`);
  await listRow(b, 'Trip').catch(() => null);
  await b.goto(`${BASE}/dm`);
  check(Boolean(await listRow(b, 'Trip').catch(() => null)), "bea's list shows \"Trip\" without opening it");
  await b.goto(`${BASE}/settings`);
  await b.waitForTimeout(1000);
  await sendText(a, 'meet at noon');
  const first = await waitForNotification(b, 1);
  check(first?.title === 'Trip' && first?.body === `${ann.name}: meet at noon`, `bea's notification: ${JSON.stringify(first && { title: first.title, body: first.body })}`);

  // Cal renames it.
  await openGroup(c, 'Trip');
  if (!(await c.$('.group-members'))) await c.click('.group-members-button');
  await c.click('.group-action:has-text("Rename")');
  await c.fill('.vc-dialog input[aria-label="Group name"]', 'Plans');
  await shot(c, '01-rename');
  await c.click('.vc-dialog button:has-text("Save")');
  await c.waitForSelector('.message-system:has-text("You renamed the group to “Plans”.")', { timeout: 20000 });
  check(true, 'cal: "You renamed the group to “Plans”." in the timeline');
  await a.waitForSelector(`.message-system:has-text("${cal.name} renamed the group to “Plans”.")`, { timeout: 20000 });
  await a.waitForSelector('.group-dm-title:text-is("Plans")', { timeout: 20000 });
  await listRow(a, 'Plans');
  check(true, "ann sees the rename live: line, header and list");
  await shot(a, '02-ann-after-rename');
  check(!(await apiText(a, groupId)).includes('Plans'), 'the new name is encrypted too');

  // Ann adds Dan: he reads the name (sealed with the new key) but not the rename before him.
  if (!(await a.$('.group-members'))) await a.click('.group-members-button');
  await a.click('button:has-text("Add people")');
  await a.check(`.user-picker-row:has-text("${dan.name}") input`);
  await a.click('.vc-dialog button:has-text("Add")');
  await a.waitForSelector(`.message-system:has-text("added ${dan.name}")`, { timeout: 20000 });
  await openGroup(d, 'Plans');
  check(await d.textContent('.group-dm-title') === 'Plans', 'dan (phone): the header says "Plans"');
  check((await d.$$('.message-system:has-text("renamed")')).length === 0, "dan doesn't see the rename from before he was in");
  await shot(d, '03-dan-phone');

  // The new key reached Bea's device too: her notification has the new name.
  await b.waitForTimeout(1500);
  // On a phone Enter is a new line: tap Send.
  await d.click('#dm-input');
  await d.keyboard.type('hi all');
  await d.click('button:has-text("Send")');
  await d.waitForTimeout(2000);
  await shot(d, '04-dan-sent');
  await a.waitForSelector('.dm-message-content:has-text("hi all")', { timeout: 20000 });
  const second = await waitForNotification(b, 2);
  if (!second) console.log('bea got:', JSON.stringify(await notifications(b)));
  check(second?.title === 'Plans' && second?.body === `${dan.name}: hi all`, `bea's next notification: ${JSON.stringify(second && { title: second.title, body: second.body })}`);

  await c.reload();
  await c.waitForSelector('.group-dm-title:text-is("Plans")', { timeout: 20000 });
  check(true, 'cal: still "Plans" after a reload');
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'OK');
process.exit(failures ? 1 : 0);
