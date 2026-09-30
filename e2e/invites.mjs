// Invite embeds in a real browser: an invite link in a channel shows its card at once; in a DM
// (encrypted) only after Show; Join Guild joins and opens it, then the card says Go to Guild.
//   node e2e/serve.mjs &   then   node e2e/invites.mjs [screenshot dir]
import { launchChrome, signUp, openChat, send, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  const a = alice.page;
  const b = bob.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Invite Test Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');

  // In a guild channel the card loads by itself; Alice is a member.
  await send(a, `join us ${link}`);
  await a.waitForSelector('.invite-embed .invite-embed-name:has-text("Invite Test Guild")', { timeout: 10000 });
  await a.waitForSelector('.invite-embed button:has-text("Go to Guild")');
  await shot(a, 'channel-embed');
  console.log('channel: card loaded by itself, Go to Guild for a member');

  // In a DM it waits for Show.
  await openChat(a, bob.id);
  let inviteRequests = 0;
  b.on('request', (r) => { if (/\/api\/invites\//.test(r.url()) && r.method() === 'GET') inviteRequests += 1; });
  await openChat(b, alice.id);
  await send(a, `here: ${link}`);
  await b.waitForSelector('.invite-embed .invite-embed-name:has-text("Guild invite")', { timeout: 10000 });
  await b.waitForTimeout(500);
  if (inviteRequests !== 0) throw new Error(`DM asked the server about the invite before Show (${inviteRequests})`);
  await shot(b, 'dm-embed-hidden');
  await b.click('.invite-embed button:has-text("Show")');
  await b.waitForSelector('.invite-embed .invite-embed-name:has-text("Invite Test Guild")');
  await b.waitForSelector('.invite-embed-hint:has-text("1 member")');
  await shot(b, 'dm-embed-shown');
  console.log('dm: nothing asked until Show, then the guild');

  // The card fits the phone's width.
  const overflow = await b.evaluate(() => {
    const card = document.querySelector('.invite-embed').getBoundingClientRect();
    return card.right > window.innerWidth || document.documentElement.scrollWidth > window.innerWidth;
  });
  if (overflow) throw new Error('invite card overflows the phone screen');

  await b.click('.invite-embed button:has-text("Join Guild")');
  await b.waitForURL(/\/guild\/\d+/, { timeout: 10000 });
  console.log('joined, opened:', b.url().replace(BASE, ''));

  await openChat(b, alice.id);
  await b.waitForSelector('.invite-embed button:has-text("Go to Guild")', { timeout: 10000 });
  await shot(b, 'dm-embed-member');
  console.log('invites: ok');
} catch (err) {
  console.error('invites: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
