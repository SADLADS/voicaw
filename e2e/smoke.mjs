// Smoke check (and example): two users register, one sends, the other sees it live.
//   node e2e/serve.mjs &   then   node e2e/smoke.mjs
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await send(alice.page, 'hello from alice');
  await bob.page.waitForSelector('text=hello from alice', { timeout: 10000 });
  console.log('smoke: ok (message delivered live)');
} catch (err) {
  console.error('smoke: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
