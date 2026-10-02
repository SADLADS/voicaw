// Calls in the chat history: Alice calls Bob three times. He answers the first (both see
// "Alice started a call that lasted …"), declines the second (Alice: "Bob declined the call.",
// Bob: "You missed a call from Alice.") and Alice hangs up the third before he answers (Bob
// is in another chat: Alice's chat goes unread for him). The notices are still there after a
// reload. Carol, on a phone, misses a call from Alice.
//   node e2e/serve.mjs &   then   node e2e/calllog.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, fakeMicArgs } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const notices = (page) => page.$$eval('.call-log', (els) => els.map((e) => ({ text: e.textContent, missed: e.classList.contains('missed') })));
async function expectNotices(page, who, expected) {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('.call-log').length === n, expected.length, { timeout: 10000 });
  } catch {
    // Reported below.
  }
  const got = await notices(page);
  const same = JSON.stringify(got.map((g) => g.text)) === JSON.stringify(expected);
  if (!same) throw new Error(`${who} sees ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  return got;
}

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;
  await openChat(a, bob.id);
  await openChat(b, alice.id);
  const callButton = `button[aria-label="Call ${bob.name}"]:not([disabled])`;

  // Answered, then Alice hangs up.
  await a.waitForSelector(callButton);
  await a.click(callButton);
  await b.click('.incoming-call button[aria-label="Accept"]');
  await b.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await a.waitForTimeout(2000);
  await a.click('.voice-bar button[aria-label="Hang up"]');
  const lasted = `${alice.name} started a call that lasted a few seconds.`;
  await expectNotices(a, 'alice', [lasted]);
  await expectNotices(b, 'bob', [lasted]);
  console.log('answered call: both see how long it lasted');

  // Declined.
  await a.waitForSelector(callButton);
  await a.click(callButton);
  await b.click('.incoming-call button[aria-label="Decline"]');
  await expectNotices(a, 'alice', [lasted, `${bob.name} declined the call.`]);
  const bobSees = await expectNotices(b, 'bob', [lasted, `You missed a call from ${alice.name}.`]);
  if (!bobSees[1].missed || bobSees[0].missed) throw new Error('only the missed call should be marked missed');
  console.log('declined call: alice told he declined, bob that he missed it');
  await shot(a, '01-alice-dm');
  await shot(b, '02-bob-dm');

  // Bob is elsewhere; Alice gives up before he answers.
  await openChat(b, carol.id);
  await a.waitForSelector(callButton);
  await a.click(callButton);
  await b.waitForSelector('.incoming-call');
  await a.click('.voice-bar button[aria-label="Hang up"]');
  await b.waitForSelector('.incoming-call', { state: 'detached' });
  await expectNotices(a, 'alice', [lasted, `${bob.name} declined the call.`, `${bob.name} didn't answer.`]);
  await b.waitForSelector(`a[href="/dm/${alice.id}"] .userdot.active`, { timeout: 10000 });
  console.log('cancelled call: unread for bob');
  await shot(b, '03-bob-elsewhere');

  // Kept after a reload.
  const after = [lasted, `You missed a call from ${alice.name}.`, `You missed a call from ${alice.name}.`];
  await openChat(b, alice.id);
  await b.reload();
  await expectNotices(b, 'bob after reload', after);
  const c = carol.page;
  await openChat(c, alice.id);
  await openChat(a, carol.id);
  await a.click(`button[aria-label="Call ${carol.name}"]:not([disabled])`);
  await c.waitForSelector('.incoming-call');
  await a.click('.voice-bar button[aria-label="Hang up"]');
  const carolSees = await expectNotices(c, 'carol on a phone', [`You missed a call from ${alice.name}.`]);
  if (!carolSees[0].missed) throw new Error('carol\'s should be marked missed');
  await shot(c, '04-carol-phone');
  console.log('calllog: ok');
} catch (err) {
  console.error('calllog: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
