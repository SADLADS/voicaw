// Code blocks' copy button: on hover on a computer, always on a phone; copies exactly the code;
// stays in the corner while a long line scrolls and clears the line's end; every theme.
//   node e2e/serve.mjs &   then   node e2e/codecopy.mjs [dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, openChat, makeFriends, send, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const THEMES = ['dark', 'light', 'familiar', 'halloween', 'christmas', 'slack'];
const LONG = `const line = "${'long '.repeat(60)}end";`;
const CODE = ['function hello() {', '', '  return "<b>*not markdown*</b> :smile:";', '}', LONG].join('\n');

function check(ok, what) {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const opacity = (button) => button.evaluate((el) => getComputedStyle(el).opacity);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { ...devices['Pixel 7'] });
  for (const person of [alice, bob]) {
    await person.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await makeFriends(alice, bob);
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  // The fence and code, line by line: Enter alone would send.
  await alice.page.click('#dm-input');
  for (const line of ['```js', ...CODE.split('\n'), '```']) {
    await alice.page.keyboard.insertText(line);
    await alice.page.keyboard.press('Shift+Enter');
  }
  await alice.page.keyboard.press('Backspace');
  await alice.page.keyboard.press('Enter');

  console.log('computer');
  const block = alice.page.locator('.dm-message-content pre.code-block').last();
  await block.waitFor({ timeout: 10000 });
  const button = block.locator('.code-block-copy');
  await alice.page.mouse.move(0, 0);
  check(await opacity(button) === '0', 'no button until hovered');
  await block.hover();
  check(await opacity(button) === '1', 'hovering the block shows it');

  const code = block.locator('code');
  const before = await button.boundingBox();
  await code.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const after = await button.boundingBox();
  check(before.x === after.x && before.y === after.y, 'stays in the corner while the code scrolls');
  const end = await code.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().right;
  });
  check(end <= after.x, 'the end of a long line scrolls clear of it');

  await button.click();
  await block.locator('button[aria-label="Copied"]').waitFor({ timeout: 2000 });
  check(await clipboard(alice.page) === CODE, 'copies exactly the code (no fence, no last newline)');
  if (dir) await block.screenshot({ path: `${dir}/computer-copied.png` });
  await block.locator('button[aria-label="Copy code"]').waitFor({ timeout: 3000 });
  check(true, 'goes back to Copy');

  const selected = await block.evaluate((el) => {
    getSelection().selectAllChildren(el);
    const text = getSelection().toString();
    getSelection().removeAllRanges();
    return text;
  });
  check(!/copy/i.test(selected), "selecting the block doesn't pick up the button");

  console.log('one line');
  for (const [typed, expected] of [['```aaa```', 'aaa'], ['before ```bbb``` after', 'bbb']]) {
    await send(alice.page, typed);
    const oneLine = alice.page.locator('.dm-message-content pre.code-block', { hasText: expected }).last();
    await oneLine.waitFor({ timeout: 10000 });
    await oneLine.hover();
    await oneLine.locator('.code-block-copy').click();
    await oneLine.locator('button[aria-label="Copied"]').waitFor({ timeout: 2000 });
    check(await clipboard(alice.page) === expected, `${typed} is a block and copies ${expected}`);
  }
  const midLine = alice.page.locator('.dm-message-content', { hasText: 'before' }).last();
  check(await midLine.locator('p', { hasText: 'after' }).count() === 1, 'the text around it stays');
  if (dir) await midLine.screenshot({ path: `${dir}/mid-line.png` });

  console.log('phone');
  const phoneBlock = bob.page.locator('.dm-message-content pre.code-block', { hasText: 'function hello' });
  await phoneBlock.waitFor({ timeout: 10000 });
  const phoneButton = phoneBlock.locator('.code-block-copy');
  check(await opacity(phoneButton) === '1', 'always shown');
  const overflow = await bob.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, 'no sideways page scroll');
  await phoneButton.tap();
  await phoneBlock.locator('button[aria-label="Copied"]').waitFor({ timeout: 2000 });
  check(await clipboard(bob.page) === CODE, 'tap copies the code');
  if (dir) await bob.page.screenshot({ path: `${dir}/phone.png` });

  console.log('themes');
  for (const theme of THEMES) {
    await alice.page.evaluate((t) => localStorage.setItem('theme', t), theme);
    await alice.page.reload();
    const themed = alice.page.locator('.dm-message-content pre.code-block').last();
    await themed.waitFor({ timeout: 15000 });
    await themed.hover();
    const colours = await themed.locator('.code-block-copy').evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor];
    });
    check(colours[0] !== colours[1], `${theme}: icon stands out from its background`);
    if (dir) await themed.screenshot({ path: `${dir}/theme-${theme}.png` });
  }
  console.log('codecopy: ok');
} catch (err) {
  console.error('codecopy: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
