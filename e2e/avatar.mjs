// Message avatars line up like Discord's: top with the top of the name, bottom with the bottom
// of the first line of text (a plain message, a reply, a grouped one under it, one starting
// with a heading, desktop and phone). Screenshots into dir if given.
//   node e2e/serve.mjs &   then   node e2e/avatar.mjs [dir]
import { launchChrome, signUp, openChat, send, devices } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome();

// After paint (e2e/README.md tips): the avatar's box, the name's text and each message's first
// line of text (a Range's rects are the font's box, not the line's).
function measure(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const text = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return [...r.getClientRects()].filter((x) => x.height > 0);
      };
      const firstLine = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && !node.textContent.trim());
        const r = document.createRange();
        r.setStart(node, 0);
        r.setEnd(node, 1);
        return r.getClientRects()[0];
      };
      resolve([...document.querySelectorAll('.each-dm-message-wrapper')].map((w) => {
        const avatar = w.querySelector('.message-avatar')?.getBoundingClientRect();
        const name = w.querySelector('.message-author');
        const content = w.querySelector('.dm-message-content');
        const nameBox = name && text(name)[0];
        const line = firstLine(content);
        const snippet = w.querySelector('.reply-snippet');
        const connector = snippet && snippet.getBoundingClientRect().left
          + parseFloat(getComputedStyle(snippet, '::before').left) + 1;
        return {
          connector,
          rowBottom: w.getBoundingClientRect().bottom,
          text: content.textContent.slice(0, 20),
          avatar: avatar && { top: avatar.top, bottom: avatar.bottom, left: avatar.left, size: avatar.width },
          nameTop: nameBox?.top,
          nameLeft: nameBox?.left,
          lineBottom: line.bottom,
          contentLeft: content.getBoundingClientRect().left,
        };
      }));
    };
    ch.port2.postMessage(null);
  })));
}

function check(label, rows) {
  let ok = true;
  for (const r of rows) {
    if (!r.avatar) continue;
    const top = r.avatar.top - r.nameTop;
    const bottom = r.avatar.bottom - r.lineBottom;
    const indent = r.nameLeft - r.contentLeft;
    console.log(`${label} "${r.text}": size ${r.avatar.size}, top ${top.toFixed(1)}, bottom ${bottom.toFixed(1)}, name indent ${indent.toFixed(1)}`);
    // The heading message's first line is taller; only its top has to match.
    const heading = r.text.startsWith('Heading');
    if (Math.abs(top) > 1.5 || (!heading && Math.abs(bottom) > 1.5) || Math.abs(indent) > 1) ok = false;
    // Inside its own row, even with one line of text.
    if (r.avatar.bottom > r.rowBottom) ok = false;
    // The reply's line comes down to the middle of the avatar.
    if (r.connector != null) {
      const off = r.connector - (r.avatar.left + r.avatar.size / 2);
      console.log(`${label} reply line off centre by ${off.toFixed(1)}`);
      if (Math.abs(off) > 1) ok = false;
    }
  }
  if (!ok) throw new Error(`${label}: avatar out of line`);
}

try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await send(alice.page, 'hello from alice, a plain message');
  await send(alice.page, 'a grouped one under it');
  const first = alice.page.locator('.each-dm-message-wrapper', { hasText: 'hello from alice' });
  await first.hover();
  await first.locator('.message-menu button:has(svg.fa-reply)').click();
  await send(alice.page, 'a reply to the first');
  await send(alice.page, '# Heading first');
  await bob.page.waitForSelector('text=Heading first');
  await alice.page.mouse.move(1, 1);

  const desktop = await measure(alice.page);
  const phone = await measure(bob.page);
  if (dir) {
    await alice.page.screenshot({ path: `${dir}/avatar-desktop.png` });
    await bob.page.screenshot({ path: `${dir}/avatar-phone.png` });
  }
  check('desktop', desktop);
  check('phone', phone);

  console.log('avatar: ok');
} catch (err) {
  console.error('avatar: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
