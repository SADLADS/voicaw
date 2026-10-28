// Letter pictures: someone without a profile picture shows their username's first letter on a
// colour from their id, the same colour on every device; a real picture still wins.
//   node e2e/serve.mjs &   then   node e2e/letteravatars.mjs [dir]
import { launchChrome, signUp, openChat, send, makeFriends } from './helpers.mjs';

const dir = process.argv[2];
const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  await makeFriends(alice, bob);
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);
  await send(alice.page, 'hello from alice');
  await bob.page.waitForSelector('text=hello from alice', { timeout: 10000 });

  const pictureOf = (page, id) => page.$$eval(`img[data-user-id="${id}"]`, (imgs) => imgs.map((i) => i.getAttribute('src')));
  const svg = (src) => decodeURIComponent(src.replace('data:image/svg+xml,', ''));
  const onBob = await pictureOf(bob.page, alice.id);
  const onAlice = await pictureOf(alice.page, alice.id);
  if (!onBob.length || !onAlice.length) throw new Error('no picture of alice drawn');
  for (const src of [...onBob, ...onAlice]) {
    if (!src.startsWith('data:image/svg+xml,')) throw new Error(`not a letter picture: ${src.slice(0, 60)}`);
    if (!svg(src).includes('>A</text>')) throw new Error('no A on alice\'s picture');
  }
  const colour = (src) => svg(src).match(/fill="(#[0-9a-f]{6})"/)[1];
  if (colour(onBob[0]) !== colour(onAlice[0])) throw new Error('alice has a different colour on each side');
  const bobs = await pictureOf(bob.page, bob.id);
  if (!bobs.length || !svg(bobs[0]).includes('>B</text>')) throw new Error('no B on bob\'s picture');

  // Drawn as a picture (not broken): it has a size.
  const width = await bob.page.$eval(`.message-avatar[data-user-id="${alice.id}"]`, (i) => i.naturalWidth);
  if (!width) throw new Error('letter picture failed to load');
  if (dir) {
    await bob.page.screenshot({ path: `${dir}/letteravatars-desktop.png` });
    await alice.page.screenshot({ path: `${dir}/letteravatars-alice.png` });
  }
  console.log(`letteravatars: ok (A on ${colour(onBob[0])} both sides, B for bob)`);
} catch (err) {
  console.error('letteravatars: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
