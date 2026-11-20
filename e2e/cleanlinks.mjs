// Remove tracking from pasted links (Settings → Privacy, off by default): pasting with it off
// changes nothing; turned on, the app gets the server's list (the throwaway API downloads
// AdGuard's filter when it starts; needs the internet, else only the built-in list), a real
// Ctrl+V of an X link and a YouTube link loses s/a and si but keeps t, Ctrl+Z gives back what was
// pasted and Ctrl+Y the cleaned text again, code is left alone, and Bob gets the clean link;
// a link put in by the keyboard (Android keyboards' clipboard suggestion: no paste event) too;
// Settings → Admin's "Tracking parameter list"; the switch at phone width.
//   node e2e/serve.mjs &   then   node e2e/cleanlinks.mjs [screenshot dir]
import { launchChrome, signUp, openChat, makeFriends, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const LABEL = 'Remove tracking from pasted links';
const X = 'https://x.com/Channel4News/status/2122354639941321113?a=lnRAVVaoK6hYw0NsZ2w&s=20';
const YT = 'https://youtu.be/dQw4w9WgXcQ?si=abc123&t=42';
const PASTED = `look ${X} and ${YT} but \`${YT}\``;
const CLEANED = 'look https://x.com/Channel4News/status/2122354639941321113 and https://youtu.be/dQw4w9WgXcQ?t=42 but `' + YT + '`';

const boxText = (page) => page.evaluate(() => window.__voicawEditorText?.() ?? document.querySelector('#dm-input').innerText.replace(/\n$/, ''));

async function paste(page, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.click('#dm-input');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(200);
}

async function clear(page) {
  await page.click('#dm-input');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'admin-alice');
  const bob = await signUp(browser, 'bob');
  await makeFriends(alice, bob);
  const a = alice.page;
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

  // Off by default: pasted as it is, and nothing asked of the server.
  let asked = 0;
  a.on('request', (req) => { if (req.url().includes('/api/link-rules')) asked++; });
  await a.goto(`${BASE}/settings/privacy`);
  if (await a.getByLabel(LABEL).isChecked()) throw new Error('should be off by default');
  await openChat(a, bob.id);
  await paste(a, PASTED);
  if ((await boxText(a)) !== PASTED) throw new Error(`changed with the setting off: ${await boxText(a)}`);
  if (asked) throw new Error('asked the server for the list with the setting off');
  await clear(a);
  console.log('off by default: pasted as it is, the list not asked for');

  // On: the app fetches the list at once.
  await a.goto(`${BASE}/settings/privacy`);
  const toggle = a.getByLabel(LABEL);
  await toggle.scrollIntoViewIfNeeded();
  const listResponse = a.waitForResponse((r) => r.url().includes('/api/link-rules'));
  await toggle.check();
  const body = await (await listResponse).json();
  const count = body.list?.rules?.length ?? 0;
  console.log(count ? `turned on: the server's list arrived (${count} rules, AdGuard ${body.list.version})` : 'turned on: the server has no list (offline?), built-in rules only');
  await toggle.evaluate((el) => el.closest('.settings-toggle').scrollIntoView({ block: 'center' }));
  await shot(a, 'privacy-setting');
  const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('linkRules') ?? 'null'));
  if (count && saved?.rules?.length !== count) throw new Error('the list was not kept on the device');

  await openChat(a, bob.id);
  await paste(a, PASTED);
  if ((await boxText(a)) !== CLEANED) throw new Error(`not cleaned as expected: ${await boxText(a)}`);
  await shot(a, 'cleaned');
  await a.keyboard.press('Control+Z');
  if ((await boxText(a)) !== PASTED) throw new Error(`Ctrl+Z didn't give back the paste: ${await boxText(a)}`);
  await a.keyboard.press('Control+Y');
  if ((await boxText(a)) !== CLEANED) throw new Error(`Ctrl+Y didn't clean it again: ${await boxText(a)}`);
  console.log('pasted: s/a and si gone, t kept, code left alone; Ctrl+Z = as pasted, Ctrl+Y = cleaned');

  await a.keyboard.press('Enter');
  await openChat(bob.page, alice.id);
  await bob.page.waitForSelector('a[href="https://x.com/Channel4News/status/2122354639941321113"]', { timeout: 10000 });
  if (await bob.page.locator('a[href*="s=20"]').count()) throw new Error('Bob got the tracking');
  console.log('sent: Bob gets the clean link');

  // A link with nothing to take out is pasted exactly as it was.
  const plain = 'https://example.com/a?b=%2F&c#utm_source=x';
  await paste(a, plain);
  if ((await boxText(a)) !== plain) throw new Error(`a clean link changed: ${await boxText(a)}`);
  await clear(a);
  console.log('a link without tracking is left exactly as pasted');

  // A phone keyboard's clipboard suggestion: the text comes in from the keyboard, no paste
  // event (CDP's insertText is that path), on its own and ending a composition.
  const cdp = await a.context().newCDPSession(a);
  await a.click('#dm-input');
  await a.keyboard.type('see ');
  await cdp.send('Input.insertText', { text: YT });
  await a.waitForTimeout(200);
  if ((await boxText(a)) !== 'see https://youtu.be/dQw4w9WgXcQ?t=42') throw new Error(`keyboard insert not cleaned: ${await boxText(a)}`);
  await a.keyboard.press('Control+Z');
  if ((await boxText(a)) !== `see ${YT}`) throw new Error(`Ctrl+Z after a keyboard insert: ${await boxText(a)}`);
  await clear(a);
  await cdp.send('Input.imeSetComposition', { text: 'wor', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: YT });
  await a.waitForTimeout(200);
  if ((await boxText(a)) !== 'https://youtu.be/dQw4w9WgXcQ?t=42') throw new Error(`insert ending a composition not cleaned: ${await boxText(a)}`);
  await a.keyboard.type(' ok');
  if ((await boxText(a)) !== 'https://youtu.be/dQw4w9WgXcQ?t=42 ok') throw new Error(`typing after it: ${await boxText(a)}`);
  await clear(a);
  console.log('keyboard insert (no paste event), also ending a composition: cleaned, Ctrl+Z = as inserted');

  // Settings → Admin's switch.
  await a.goto(`${BASE}/settings/admin`);
  await a.waitForSelector('label:has-text("Tracking parameter list")', { timeout: 10000 });
  await a.locator('label:has-text("Tracking parameter list")').scrollIntoViewIfNeeded();
  await shot(a, 'admin-setting');
  console.log('Settings → Admin lists "Tracking parameter list"');

  // Phone width.
  const phone = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await phone.page.goto(`${BASE}/settings/privacy`);
  const phoneToggle = phone.page.getByLabel(LABEL);
  await phoneToggle.scrollIntoViewIfNeeded();
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) throw new Error(`the page scrolls sideways by ${overflow}px on a phone`);
  await phoneToggle.evaluate((el) => el.closest('.settings-toggle').scrollIntoView({ block: 'center' }));
  await shot(phone.page, 'phone-setting');
  console.log('phone: the switch fits');
  console.log('cleanlinks: ok');
} catch (err) {
  console.error('cleanlinks: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
