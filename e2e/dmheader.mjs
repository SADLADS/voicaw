// The DM header: the other person's picture before their name, with their status diamond on its
// corner (online, then offline once they leave), on a computer and a phone.
//   node e2e/serve.mjs &   then   node e2e/dmheader.mjs [dir]
import { launchChrome, signUp, openChat, makeFriends, devices } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const phone = await signUp(browser, 'phone', devices['Pixel 7']);
  const bob = await signUp(browser, 'bob');
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
    if (!nameAfter.startsWith(bob.name)) throw new Error(`${who}: "${nameAfter}" after the picture, wanted ${bob.name}`);
    console.log(`  ok: ${who}: picture before the name, online diamond`);
    if (dir) await page.screenshot({ path: `${dir}/dmheader-${who}-online.png`, clip: { x: 0, y: header.y, width: page.viewportSize().width, height: header.height + 8 } });
  }

  await bob.page.context().close();
  for (const [who, page] of [['desktop', alice.page], ['phone', phone.page]]) {
    await page.locator('.chat-recipient-avatar .status-icon.offline').waitFor({ timeout: 30000 });
    console.log(`  ok: ${who}: offline diamond once they leave`);
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
