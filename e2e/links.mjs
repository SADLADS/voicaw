// Links in messages open in a new tab, and following one doesn't leave voice: Alice joins a
// voice channel, sends a link in #general and clicks it; a new tab opens, her page stays put
// and she's still connected.
//   node e2e/serve.mjs &   then   node e2e/links.mjs [screenshot dir]
import { launchChrome, signUp, send, fakeMicArgs } from './helpers.mjs';

const shots = process.argv[2];
const browser = await launchChrome({ args: fakeMicArgs() });
try {
  const alice = await signUp(browser, 'alice');
  const a = alice.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Links Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');

  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  await a.click('.guild-channel-link:has-text("lounge")');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  console.log('alice connected to voice');

  await a.click('.guild-channel-link:has-text("general")');
  await a.waitForSelector('#dm-input');
  const general = a.url();
  const url = 'https://example.com/';
  await send(a, `look ${url}`);
  const link = a.locator(`a[href="${url}"]`).first();
  await link.waitFor();
  console.log('link:', JSON.stringify(await link.evaluate((el) => ({ target: el.target, rel: el.rel }))));

  const [tab] = await Promise.all([a.context().waitForEvent('page'), link.click()]);
  console.log('new tab opened:', tab.url() || '(loading)');
  await a.waitForTimeout(3000);
  if (a.url() !== general) throw new Error(`app page navigated to ${a.url()}`);
  if (!(await a.$('.voice-bar-status.connected'))) throw new Error('left voice after clicking the link');
  console.log('app page stayed, still connected to voice');
  if (shots) await a.screenshot({ path: `${shots}/link-clicked.png` });
  console.log('OK');
} finally {
  await browser.close();
}
