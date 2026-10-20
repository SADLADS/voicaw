// The rail's Direct Messages button goes back to the DM page last open: Alice talks to Carol last,
// then reads Bob's DM and opens a guild; the button takes her back to Bob (not the newest, Carol),
// then to Friends after Friends; a remembered conversation with a bot that's gone lands on the
// DMs (the newest) instead; a phone does the same (showing the list).
//   node e2e/serve.mjs &   then   node e2e/lastdm.mjs [screenshot dir]
import { launchChrome, signUp, devices, makeFriends, openChat, send, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log('ok:', what);
};

const RAIL_DMS = 'a[aria-label="Direct Messages"]';

async function makeGuild(page, name) {
  await page.click('button[aria-label="Add a guild"]');
  await page.fill('#new-guild-name', name);
  await page.click('button:has-text("Create")');
  await page.waitForSelector('.guild-channel.active:has-text("general")');
  return new URL(page.url()).pathname;
}

// From the guild, the rail's DMs button; the page it settles on.
async function backToDms(page, guildPath, settledOn) {
  await page.click(`a[href="${guildPath.split('/').slice(0, 3).join('/')}"]`);
  await page.waitForSelector('.guild-channel.active');
  await page.click(RAIL_DMS);
  await page.waitForURL((url) => settledOn.test(url.pathname), { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  return new URL(page.url()).pathname;
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', { ...devices['Pixel 7'] });
  await makeFriends(alice, bob, carol);
  const a = alice.page;

  await openChat(a, bob.id);
  await send(a, 'hello bob');
  await openChat(a, carol.id);
  await send(a, 'hello carol');
  await a.waitForTimeout(500);
  await openChat(a, bob.id);
  const guildPath = await makeGuild(a, 'Last DM Guild');

  check(await backToDms(a, guildPath, /^\/dm\/\d+$/) === `/dm/${bob.id}`, 'DMs button goes back to Bob (not the newest, Carol)');
  await a.waitForSelector('#dm-input');
  await shot(a, 'back-to-bob');

  await a.click('.dm-list a[href="/dm/friends"], a[href="/dm/friends"]');
  await a.waitForURL((url) => url.pathname === '/dm/friends');
  check(await backToDms(a, guildPath, /^\/dm\/friends$/) === '/dm/friends', 'and to Friends after Friends');

  // A conversation with a bot deleted elsewhere: the DMs, which open the newest.
  await a.evaluate(() => localStorage.setItem('lastDm', '/dm/b/999999'));
  check(await backToDms(a, guildPath, /^\/dm\/\d+$/) === `/dm/${carol.id}`, 'a gone conversation lands on the newest DM');
  check(await a.evaluate(() => localStorage.getItem('lastDm')) === `/dm/${carol.id}`, 'which is remembered instead');

  // Phone: the button goes back to the remembered DM too.
  const c = carol.page;
  const guild = await c.evaluate(async () => {
    const res = await fetch('/api/guilds', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Phone Guild' }) });
    return res.json();
  });
  await openChat(c, alice.id);
  await c.goto(`${BASE}/guild/${guild.id}/${guild.channels[0].id}`);
  await c.waitForSelector('#dm-input');
  await c.evaluate(() => history.back());
  await c.waitForTimeout(500);
  await c.tap(RAIL_DMS);
  await c.waitForURL((url) => url.pathname === `/dm/${alice.id}`, { timeout: 10000 });
  await c.waitForTimeout(500);
  check(true, 'phone\'s DMs button goes back to Alice');
  const pane = await c.evaluate(() => {
    const w = document.querySelector('.pane-content, .pane-list');
    return w?.classList.contains('pane-content') ? 'content' : w?.classList.contains('pane-list') ? 'list' : 'none';
  });
  check(pane === 'list', 'and shows the DM list, as before');
  await shot(c, 'phone');

  console.log('lastdm: ok');
} catch (err) {
  console.error('lastdm: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
