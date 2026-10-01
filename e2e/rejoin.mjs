// Voice rejoins a channel after a lost connection: the connections of Alice (computer) and
// Carol (phone) to the e2e LiveKit are cut (its signalling WebSocket closed, new ones refused,
// as a lost network looks to the page). Alice's voice bar says "Reconnecting…" and keeps
// trying; once LiveKit can be reached again she's in again without doing anything (her own
// rejoin, not LiveKit's retries: one has failed first). Carol's app is "in the background"
// meanwhile (iOS would have frozen it): she doesn't try then, and rejoins as soon as it's
// back in view. Leaving while reconnecting stays left.
//   node e2e/serve.mjs &   then   node e2e/rejoin.mjs [screenshot dir]
// Takes a minute or two.
import { launchChrome, signUp, devices, fakeMicArgs, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const livekitPort = process.env.E2E_LIVEKIT_PORT || Number(process.env.E2E_API_PORT || 3099) + 2;

// Passes a browser context's LiveKit signalling through, until cut().
async function livekitLine(context) {
  let down = false;
  const open = new Set();
  await context.routeWebSocket((url) => url.port === String(livekitPort), (ws) => {
    if (down) {
      ws.close({ code: 1006 }).catch(() => ws.close());
      return;
    }
    const server = ws.connectToServer();
    const pair = { ws, server };
    open.add(pair);
    ws.onClose(() => open.delete(pair));
  });
  // LiveKit checks over HTTP why a WebSocket failed: that's down too.
  await context.route((url) => url.port === String(livekitPort), (route) => (down ? route.abort('connectionrefused') : route.continue()));
  return {
    cut() {
      down = true;
      for (const { ws, server } of open) {
        server.close().catch(() => {});
        ws.close().catch(() => {});
      }
      open.clear();
    },
    restore() {
      down = false;
    },
  };
}

// Pretends the page went to the background / came back (as a phone's app switcher would).
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const status = (page) => page.$eval('.voice-bar-status', (el) => el.className).catch(() => 'no voice bar');

const browser = await launchChrome({ args: fakeMicArgs() });
try {
  // Routing (below) doesn't see what the service worker fetches.
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 750 }, serviceWorkers: 'block' });
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'], serviceWorkers: 'block' });
  const a = alice.page;
  const c = carol.page;
  const aliceLine = await livekitLine(a.context());
  const carolLine = await livekitLine(c.context());
  const cutAll = () => { aliceLine.cut(); carolLine.cut(); console.log('LiveKit cut off'); };
  const restoreAll = () => { aliceLine.restore(); carolLine.restore(); console.log('LiveKit reachable'); };
  await a.reload(); // the routing above applies to pages loaded after it
  let aliceRejoinFailed = false;
  a.on('console', (m) => { if (m.text().includes('Could not connect to voice')) aliceRejoinFailed = true; });
  for (const [who, page] of [['alice', a], ['carol', c]]) {
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('WebSocket')) console.log(`[${who} error]`, m.text().slice(0, 200));
    });
  }

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Rejoin Test');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('#dm-input');
  await a.click('.guild-header-button');
  await a.click('text=Create Channel');
  await a.click('label:has-text("Voice")');
  await a.fill('#channel-name', 'Lounge');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.voice-view-join');
  const loungeUrl = a.url().replace(/^https?:\/\/[^/]+/, BASE);
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  await a.waitForFunction(() => document.querySelector('#invite-link')?.value);
  const link = await a.inputValue('#invite-link');
  await a.keyboard.press('Escape');

  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.click('button:has-text("Accept invite")');
  await c.waitForSelector('#dm-input');

  await a.click('.voice-view-join');
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 20000 });
  await c.goto(loungeUrl);
  await c.waitForSelector('.voice-view-join');
  await c.waitForTimeout(600);
  await c.click('.voice-view-join');
  await c.waitForSelector('.voice-view-controls');
  await a.waitForSelector(`.voice-tile:has-text("${carol.name}")`, { timeout: 15000 });
  console.log('alice and carol in voice');

  // Carol's app goes to the background; then LiveKit goes away.
  await setHidden(c, true);
  cutAll();

  await a.waitForSelector('.voice-bar-status.reconnecting', { timeout: 60000 });
  console.log('alice: Reconnecting…');
  await shot(a, '01-alice-reconnecting');

  // LiveKit gives up on the old connection after a while, then our rejoin tries (and fails
  // while LiveKit is down); Alice's bar must keep saying Reconnecting (not drop her out).
  const started = Date.now();
  while (!aliceRejoinFailed) {
    if (Date.now() - started > 240000) throw new Error('alice never tried to rejoin');
    const s = await status(a);
    if (!s.includes('reconnecting')) throw new Error(`alice's voice bar while LiveKit is down: ${s}`);
    await a.waitForTimeout(2000);
  }
  console.log(`alice's own rejoin tried after ${Math.round((Date.now() - started) / 1000)} s and failed; bar:`, await status(a));
  const carolTokens = [];
  c.on('request', (r) => { if (/\/channels\/\d+\/voice$/.test(r.url())) carolTokens.push(r.url()); });

  restoreAll();
  await a.waitForSelector('.voice-bar-status.connected', { timeout: 40000 });
  console.log('alice rejoined by herself');
  await c.waitForTimeout(12000);
  if (carolTokens.length) throw new Error(`carol tried to rejoin in the background: ${carolTokens}`);
  console.log('carol (in the background) waited; her bar:', await status(c));

  await setHidden(c, false);
  await a.waitForSelector(`.voice-tile:has-text("${carol.name}")`, { timeout: 30000 });
  await c.waitForSelector(`.voice-tile:has-text("${alice.name}")`, { timeout: 15000 });
  console.log('carol back in view: rejoined, token requests:', carolTokens.length);
  await shot(c, '02-carol-rejoined');
  await shot(a, '03-alice-sees-carol');

  // Leaving while reconnecting stays left.
  cutAll();
  await a.waitForSelector('.voice-bar-status.reconnecting', { timeout: 60000 });
  await a.click('.voice-bar-leave');
  await a.waitForSelector('.voice-bar', { state: 'detached', timeout: 5000 });
  restoreAll();
  await a.waitForTimeout(15000);
  if (await a.$('.voice-bar')) throw new Error('alice rejoined after leaving');
  console.log('alice left while reconnecting: stays out');
  console.log('rejoin: all good');
} finally {
  await browser.close();
}
