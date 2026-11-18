// The DM header: the other person's picture before their name, with their status diamond on its
// corner (online, then offline once they leave), on a computer and a phone. A name as long as a
// display name can be (32 wide letters) is cut with … and "Last seen" with it, so neither pushes
// the call, pins or search buttons off the screen nor touches them; a phone puts "Last seen" on
// its own line under the name.
//   node e2e/serve.mjs &   then   node e2e/dmheader.mjs [dir]
import { launchChrome, signUp, openChat, makeFriends, devices } from './helpers.mjs';

const dir = process.argv[2];
const LONG_NAME = 'W'.repeat(32);
const browser = await launchChrome();

// Every button in the header on screen, and the name and status ending before the first of them.
async function checkFits(page, who, offline) {
  const r = await page.evaluate(() => {
    const box = (el) => el && el.getBoundingClientRect();
    const header = document.querySelector('.chat-recipient-header');
    // Search is a box on a computer, a button on a phone.
    const buttons = [...header.querySelectorAll('.chat-call-button, .search-button, .guild-search')].map(box);
    const name = document.querySelector('.chat-recipient-name');
    return {
      width: document.documentElement.clientWidth,
      buttons: buttons.map((b) => ({ left: b.left, right: b.right, width: b.width })),
      name: box(name),
      cut: name.scrollWidth > name.clientWidth,
      status: box(document.querySelector('.chat-recipient-title .chat-recipient-status')),
    };
  });
  if (r.buttons.length < 3) throw new Error(`${who}: ${r.buttons.length} header buttons, wanted call, pins and search`);
  for (const b of r.buttons) {
    if (b.right > r.width + 0.5) throw new Error(`${who}: a header button ends at ${b.right}, past the screen's ${r.width}`);
    if (b.width < 30) throw new Error(`${who}: a header button squashed to ${b.width} px`);
  }
  const firstLeft = Math.min(...r.buttons.map((b) => b.left));
  if (r.name.right > firstLeft - 4) throw new Error(`${who}: the name reaches ${r.name.right}, the buttons start at ${firstLeft}`);
  if (!r.cut) throw new Error(`${who}: the long name isn't cut`);
  if (offline) {
    if (!r.status) throw new Error(`${who}: no "Last seen"`);
    if (r.status.right > firstLeft - 4) throw new Error(`${who}: "Last seen" reaches ${r.status.right}, the buttons start at ${firstLeft}`);
    if (who === 'phone' && r.status.top < r.name.bottom - 2) throw new Error(`${who}: "Last seen" not under the name`);
  }
  console.log(`  ok: ${who}: long name cut, buttons on screen${offline ? ', "Last seen" clear of them' : ''}`);
}

try {
  const alice = await signUp(browser, 'alice');
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  const bob = await signUp(browser, 'bob');
  await bob.page.evaluate(async (displayName) => {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) throw new Error(`profile ${res.status}`);
  }, LONG_NAME);
  await makeFriends(alice, bob, phone);

  for (const [who, page] of [['desktop', alice.page], ['phone', phone.page]]) {
    await openChat(page, bob.id);
    const wrap = page.locator('.chat-recipient-header .chat-recipient-avatar');
    await wrap.locator(`img[data-user-id="${bob.id}"]`).waitFor({ timeout: 10000 });
    await wrap.locator('.status-icon.online').waitFor({ timeout: 10000 });
    // Before the name, on the header's line, 24 px.
    const box = await wrap.boundingBox();
    const header = await page.locator('.chat-recipient-header').boundingBox();
    const nameAfter = await page.evaluate(() => {
      const w = document.querySelector('.chat-recipient-avatar');
      return w.nextSibling?.textContent ?? '';
    });
    if (Math.round(box.width) !== 24 || Math.round(box.height) !== 24) throw new Error(`${who}: picture is ${box.width}x${box.height}`);
    if (box.y < header.y || box.y + box.height > header.y + header.height) throw new Error(`${who}: picture outside the header`);
    if (!nameAfter.startsWith(LONG_NAME)) throw new Error(`${who}: "${nameAfter}" after the picture, wanted ${LONG_NAME}`);
    console.log(`  ok: ${who}: picture before the name, online diamond`);
    await page.locator('.chat-recipient-header :is(.search-button, .guild-search)').waitFor({ timeout: 10000 });
    await checkFits(page, who, false);
    if (dir) await page.screenshot({ path: `${dir}/dmheader-${who}-online.png`, clip: { x: 0, y: header.y, width: page.viewportSize().width, height: header.height + 8 } });
  }

  await bob.page.context().close();
  for (const [who, page] of [['desktop', alice.page], ['phone', phone.page]]) {
    await page.locator('.chat-recipient-avatar .status-icon.offline').waitFor({ timeout: 30000 });
    await page.locator('.chat-recipient-title .chat-recipient-status').waitFor({ timeout: 10000 });
    console.log(`  ok: ${who}: offline diamond once they leave`);
    await checkFits(page, who, true);
    if (dir) {
      const header = await page.locator('.chat-recipient-header').boundingBox();
      await page.screenshot({ path: `${dir}/dmheader-${who}-offline.png`, clip: { x: 0, y: header.y, width: page.viewportSize().width, height: header.height + 8 } });
    }
  }
  console.log('dmheader: ok');
} catch (err) {
  console.error('dmheader: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
