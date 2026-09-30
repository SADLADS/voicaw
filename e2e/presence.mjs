// Online status: online, idle after 10 minutes without input, mobile when only a phone is
// active, no flicker on reload, offline (with last seen) a moment after the last tab closes.
//   node e2e/serve.mjs &   then   node e2e/presence.mjs [screenshot dir]
import { launchChrome, signUp, openChat, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const browser = await launchChrome();
const api = (page, method, url, body) => page.evaluate(async ([method, url, body]) => {
  const res = await fetch(`/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return res.json();
}, [method, url, body]);

try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob', { viewport: { width: 1100, height: 750 }, deviceScaleFactor: 2 });
  await openChat(bob.page, alice.id);
  const dot = `a[href="/dm/${alice.id}"] .status-icon`;
  const waitStatus = (status) => bob.page.waitForSelector(`${dot}.${status}`, { timeout: 30000 });
  await waitStatus('online');
  if (await bob.page.$('.chat-recipient-status')) throw new Error('status text in the DM header while online');

  // Every class alice's dot has on bob's screen from now on.
  await bob.page.evaluate((sel) => {
    window.seen = [];
    const el = document.querySelector(sel);
    new MutationObserver(() => window.seen.push(el.className)).observe(el, { attributes: true });
  }, dot);

  // Alice reloads (with a controllable clock): nobody sees her go offline.
  await alice.page.clock.install();
  await alice.page.reload();
  await alice.page.waitForSelector('#dm-main');
  await alice.page.waitForTimeout(2000);
  const seen = await bob.page.evaluate(() => window.seen);
  if (seen.some((c) => c.includes('offline'))) throw new Error(`reload showed as offline: ${seen}`);

  // Ten minutes without input: idle.
  await alice.page.clock.fastForward('10:30');
  await waitStatus('idle');
  if (shots) await bob.page.locator(`a[href="/dm/${alice.id}"]`).screenshot({ path: `${shots}/presence-dm-idle.png` });

  // Alice on her phone too: her computer is idle, so mobile.
  const phoneContext = await browser.newContext({ ...devices['Pixel 7'] });
  const phone = await phoneContext.newPage();
  await phone.clock.install();
  await phone.goto(`${BASE}/`);
  await phone.fill('input[placeholder="Username"]', alice.name);
  await phone.fill('input[placeholder="Password"]', 'correct horse battery alice');
  await phone.click('button:has-text("Login")');
  await phone.waitForSelector('#dm-main', { timeout: 20000 });
  await waitStatus('mobile');
  await bob.page.waitForSelector(`${dot}[title="Online on mobile"]`);
  if (shots) await bob.page.locator(`a[href="/dm/${alice.id}"]`).screenshot({ path: `${shots}/presence-dm-mobile.png` });

  // In a guild's member list too.
  const guild = await api(bob.page, 'POST', '/guilds', { name: 'Presence' });
  const invite = await api(bob.page, 'POST', `/guilds/${guild.id}/invites`);
  await api(phone, 'POST', `/invites/${invite.code}`);
  await bob.page.goto(`${BASE}/guild/${guild.id}`);
  await bob.page.waitForSelector('.member-avatar .status-icon.mobile');
  await shot(bob.page, 'presence-member-mobile');
  await bob.page.click(`.member-row:has-text("${alice.name}")`);
  await bob.page.waitForSelector('.profile-card-presence.mobile:has-text("Online on mobile")');
  await shot(bob.page, 'presence-member-card');
  if (shots) await bob.page.locator('.member-list').screenshot({ path: `${shots}/presence-members-mobile.png` });

  // Back at the computer: online beats mobile.
  await alice.page.mouse.move(200, 200);
  await alice.page.mouse.move(300, 300);
  await bob.page.waitForSelector('.profile-card-presence.online:has-text("Online")', { timeout: 30000 });

  // Neither touched for ten minutes: idle.
  await alice.page.clock.fastForward('10:30');
  await phone.clock.fastForward('10:30');
  await bob.page.waitForSelector('.member-avatar .status-icon.idle', { timeout: 30000 });
  if (shots) await bob.page.locator('.member-list').screenshot({ path: `${shots}/presence-members-idle.png` });
  await bob.page.goBack();
  await bob.page.waitForSelector(dot);
  await alice.page.mouse.move(100, 100);
  await waitStatus('online');

  // Both gone: offline after the grace period, last seen just now.
  await alice.page.context().close();
  await phoneContext.close();
  await bob.page.waitForTimeout(5000);
  if (await bob.page.$(`${dot}.offline`)) throw new Error('offline before the grace period');
  await waitStatus('offline');
  await bob.page.waitForSelector(`${dot}[title="Last seen just now"]`);
  await bob.page.waitForSelector('.chat-recipient-status:has-text("Last seen just now")');
  await shot(bob.page, 'presence-dm-offline');
  console.log('presence e2e: ok');
} catch (err) {
  console.error('presence e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
