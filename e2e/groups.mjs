// Group DMs in real browsers: Ann makes a group with Bea and Cal and they talk; Bea adds Dan,
// who sees what's said from then on but not before; Ann (the owner) removes Cal; a group call
// (Bea starts it, Ann answers, Dan joins later from the group) that LiveKit only sees
// encrypted; Ann leaves and the group has no owner any more. Every message is signed and
// checks out.
//   node e2e/serve.mjs &   then   node e2e/groups.mjs [screenshot dir]
// (E2E_API_PORT too when serve.mjs isn't on the default ports: it reads LiveKit's keys.)
import { readFileSync } from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { launchChrome, signUp, devices, fakeMicArgs, livekitInfoPath, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const livekit = JSON.parse(readFileSync(livekitInfoPath(), 'utf8'));
const roomService = new RoomServiceClient(livekit.url, livekit.key, livekit.secret);

async function sendText(page, text) {
  await page.click('#dm-input');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}
const messageTexts = (page) => page.$$eval('.dm-message-content', (els) => els.map((e) => e.textContent.trim()));
const openGroup = async (page, name) => {
  await page.goto(`${BASE}/dm`);
  // On a phone /dm opens the first chat, which covers the list: follow the row's link.
  const href = await page.getAttribute(`.dm-group:has-text("${name}")`, 'href');
  await page.goto(`${BASE}${href}`);
  await page.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
};

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  const cal = await signUp(browser, 'cal');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const [a, b, c, d] = [ann.page, bea.page, cal.page, dan.page];
  for (const [who, page] of [['ann', a], ['bea', b], ['cal', c], ['dan', d]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated|abort/i.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
  }

  // Ann makes the group.
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await shot(a, '01-new-group');
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await a.waitForSelector('.message-system:has-text("You created the group.")');
  await sendText(a, 'hello group');
  await a.waitForSelector('.dm-message-content:has-text("hello group")');
  console.log('ann made "Trip" and wrote in it');

  await openGroup(b, 'Trip');
  await b.waitForSelector('.dm-message-content:has-text("hello group")');
  await sendText(b, 'hi ann');
  await a.waitForSelector('.dm-message-content:has-text("hi ann")');
  console.log('bea reads it (decrypted) and answers live');
  await shot(b, '02-bea-in-group');

  // Bea adds Dan: he sees what comes next, not what came before.
  await b.click('button:has-text("Add people")');
  await b.check(`.user-picker-row:has-text("${dan.name}") input`);
  await b.click('.vc-dialog button:has-text("Add")');
  await b.waitForSelector(`.group-member:has-text("${dan.name}")`);
  await b.waitForSelector(`.message-system:has-text("added ${dan.name}")`);
  await sendText(b, 'welcome dan');
  await openGroup(d, 'Trip');
  await d.waitForSelector('.dm-message-content:has-text("welcome dan")');
  const danSees = await messageTexts(d);
  console.log('dan sees:', JSON.stringify(danSees));
  if (danSees.some((t) => t.includes('hello group') || t.includes('hi ann'))) throw new Error('dan sees messages from before he joined');
  await d.waitForTimeout(500);
  await shot(d, '03-dan-phone-after-joining');

  // Only the owner removes: Ann removes Cal.
  await openGroup(c, 'Trip');
  if (await b.$(`button[aria-label="Remove ${cal.name}"]`)) throw new Error('bea (not the owner) can remove people');
  await a.click(`button[aria-label="Remove ${cal.name}"]`);
  await a.click('.vc-dialog button:has-text("Remove")');
  await c.waitForURL('**/dm', { timeout: 10000 });
  await sendText(a, 'cal is gone');
  await b.waitForSelector('.dm-message-content:has-text("cal is gone")');
  if (await c.$('.dm-group:has-text("Trip")')) throw new Error('cal still has the group');
  console.log('ann removed cal: cal is out, the rest carry on (with a new key)');
  await shot(a, '04-ann-after-removing-cal');

  // A group call: Bea starts it, Ann answers, Dan joins from the group later.
  await b.click('button[aria-label="Start a group call"]');
  await a.waitForSelector('.incoming-call:has-text("Trip")');
  await d.waitForSelector('.incoming-call');
  await shot(a, '05-ann-group-call-ringing');
  await a.click('.incoming-call button[aria-label="Accept"]');
  await d.click('.incoming-call button[aria-label="Decline"]');
  await a.waitForSelector('.group-call-panel .voice-view-controls', { timeout: 20000 });
  await d.waitForSelector('.group-call-panel button:has-text("Join call")');
  await d.click('.group-call-panel button:has-text("Join call")');
  await d.waitForSelector('.group-call-panel .voice-view-controls', { timeout: 20000 });
  await b.waitForFunction(() => document.querySelectorAll('.group-call-panel .call-panel-person').length === 3);
  await b.waitForSelector('.group-call-panel .user-avatar.speaking', { timeout: 15000 });
  console.log('three in the group call');
  const room = (await roomService.listRooms()).find((r) => r.name.startsWith('call-'));
  // (The rings light as soon as a voice is heard, which can be before the last one has published.)
  let tracks = [];
  for (let i = 0; i < 50 && tracks.length < 3; i++) {
    if (i) await d.waitForTimeout(200);
    tracks = (await roomService.listParticipants(room.name)).flatMap((p) => p.tracks.map((t) => t.encryption));
  }
  console.log('track encryption in LiveKit:', JSON.stringify(tracks));
  if (tracks.length !== 3 || tracks.some((e) => !e)) throw new Error('group call audio is not end-to-end encrypted');
  await shot(b, '06-bea-group-call');
  await d.waitForTimeout(500);
  await shot(d, '07-dan-phone-group-call');

  await a.click('.group-call-panel button[aria-label="Leave call"]');
  await b.waitForFunction(() => document.querySelectorAll('.group-call-panel .call-panel-person').length === 2);
  await b.click('.group-call-panel button[aria-label="Leave call"]');
  await d.click('.group-call-panel button[aria-label="Leave call"]');
  await b.waitForSelector('.group-call-panel', { state: 'detached', timeout: 10000 });
  console.log('everyone left: the call is over');

  // The owner leaves: nobody is owner.
  await a.click('button:has-text("Leave group")');
  await a.click('.vc-dialog button:has-text("Leave Group")');
  await a.waitForURL('**/dm');
  await b.waitForSelector(`.message-system:has-text("${ann.name} left the group.")`);
  if (await b.$('.group-owner-crown')) throw new Error('someone is still owner');
  await sendText(b, 'just us now');
  await d.waitForSelector('.dm-message-content:has-text("just us now")');
  console.log('ann left: no owner, the others carry on');
  // Every message is signed and checks out: no "not signed" / "unverified sender" marks.
  for (const page of [b, d]) {
    if (await page.$('.message-signature')) throw new Error('a message shows as unsigned or unverified');
  }
  console.log('all messages signed and verified');
  await shot(b, '08-bea-after-ann-left');
  console.log('OK');
} finally {
  await browser.close();
}
