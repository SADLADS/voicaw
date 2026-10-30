// Thai: the app in Thai (Settings → Language, kept on the device), a DM, Settings, a guild and
// a phone, screenshotted into dir; no English left in the main chrome, no text overflowing.
//   node e2e/serve.mjs &   then   node e2e/thai.mjs [dir]
import { mkdirSync } from 'fs';
import { launchChrome, signUp, openChat, send, makeFriends, devices, BASE } from './helpers.mjs';

const dir = process.argv[2] || '/tmp/voicaw-e2e-thai';
mkdirSync(dir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${dir}/${name}.png` });

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', devices['Pixel 7']);
  await makeFriends(alice, bob);

  // Choosing Thai in Settings → Language reloads the app in it.
  await alice.page.goto(`${BASE}/settings/language`);
  await alice.page.selectOption('select', 'th');
  await alice.page.waitForFunction(() => document.documentElement.lang === 'th', null, { timeout: 15000 });
  await alice.page.waitForSelector('text=ภาษา');
  await shot(alice.page, 'settings-language');

  await openChat(alice.page, bob.id);
  await send(alice.page, 'สวัสดี');
  await alice.page.waitForSelector('text=สวัสดี');
  const placeholder = await alice.page.getAttribute('#dm-input', 'aria-label');
  if (!/ส่งข้อความถึง/.test(placeholder ?? '')) throw new Error(`message box label is ${placeholder}`);
  await shot(alice.page, 'dm');

  await alice.page.goto(`${BASE}/settings/privacy`);
  await alice.page.waitForSelector('text=ความเป็นส่วนตัว');
  await shot(alice.page, 'settings-privacy');

  // A guild, from the rail's +.
  await alice.page.goto(`${BASE}/dm`);
  await alice.page.click('[aria-label="เพิ่มกิลด์"]');
  await alice.page.fill('input[placeholder="ชื่อกิลด์"]', 'กิลด์ทดสอบ');
  await alice.page.keyboard.press('Enter');
  await alice.page.waitForSelector('text=ยินดีต้อนรับสู่', { timeout: 15000 });
  await shot(alice.page, 'guild');

  // The phone: Thai from the start (stored before loading).
  await bob.page.evaluate(() => localStorage.setItem('voicaw-language', 'th'));
  await openChat(bob.page, alice.id);
  await bob.page.waitForSelector('text=สวัสดี');
  await shot(bob.page, 'phone-dm');
  await bob.page.goto(`${BASE}/settings`);
  await bob.page.waitForSelector('text=บัญชีของฉัน');
  await shot(bob.page, 'phone-settings');

  // Nothing wider than the screen on the phone.
  const overflow = await bob.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`phone settings overflow by ${overflow}px`);
  console.log(`thai: ok (screenshots in ${dir})`);
} catch (err) {
  console.error('thai: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
