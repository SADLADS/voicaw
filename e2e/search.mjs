// Guild search: from:/in:/has:/mentions: suggestions in the header box, results under it,
// Jump into another channel's history that isn't loaded yet, sorting, unknown names, a
// private channel's messages staying out of reach, and the phone's full-screen search.
//   node e2e/serve.mjs &   then   node e2e/search.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import { launchChrome, signUp, send, BASE, devices } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => (dir ? page.screenshot({ path: `${dir}/${name}.png` }) : null);

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

const resultTexts = (page) => page.locator('.search-panel .search-result .dm-message-content').allTextContents();

// Types into the search box (after clearing it) and waits for the results to settle.
async function searchFor(page, text) {
  const input = page.locator('.guild-search-input');
  await input.fill('');
  await input.type(text);
  const searched = page.waitForResponse((r) => r.url().includes('/messages/search'), { timeout: 3000 }).catch(() => null);
  await page.keyboard.press('Enter');
  await searched; // none when the box has a name it doesn't know
  await page.locator('.search-panel').waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.search-panel');
    return panel && !panel.textContent.includes('Searching…') &&
      (panel.querySelector('.search-result, .pins-panel-empty, .error-text'));
  }, null, { timeout: 10000 });
}

const browser = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const a = alice.page;
  const c = carol.page;

  const guild = await api(a, 'POST', '/guilds', { name: 'Searchers' });
  const general = guild.channels[0];
  const random = await api(a, 'POST', `/guilds/${guild.id}/channels`, { name: 'random' });
  const secret = await api(a, 'POST', `/guilds/${guild.id}/channels`, { name: 'secret' });
  const everyone = guild.roles.find((r) => r.is_everyone);
  await api(a, 'PUT', `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: 1 });
  for (const who of [bob, carol]) {
    const invite = await api(a, 'POST', `/guilds/${guild.id}/invites`, {});
    await api(who.page, 'POST', `/invites/${invite.code}`);
  }
  const say = (page, channel, content) => api(page, 'POST', `/channels/${channel.id}/messages`, { content });
  // An old message in #random, with enough after it that it isn't in the first page.
  await say(a, random, 'the treasure map is under the old oak');
  for (let i = 1; i <= 120; i++) await say(a, random, `random chatter ${i}`);
  await say(bob.page, general, `pizza night? <@${alice.id}> see https://example.com/menu`);
  await say(a, general, 'pizza is fine by me');
  await say(a, secret, 'the secret pizza recipe');

  // ---- Computer ----
  console.log('computer');
  await a.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await a.waitForSelector('#dm-input');
  const box = a.locator('.guild-search-input');
  await box.click();
  await a.locator('.guild-search-suggestions').waitFor();
  const keys = await a.locator('.guild-search-suggestion strong').allTextContents();
  check(keys.join(' ') === 'from: mentions: in: has:', `an empty box offers the filters (${keys.join(' ')})`);
  await shot(a, '01-options');
  await a.locator('.guild-search-suggestion', { hasText: 'from:' }).click();
  check(await box.inputValue() === 'from:', 'picking one writes it');
  await a.keyboard.type(bob.name.slice(0, 3));
  await a.locator('.guild-search-suggestion', { hasText: bob.name }).waitFor();
  await shot(a, '02-members');
  await a.keyboard.press('Enter');
  check(await box.inputValue() === `from:${bob.name} `, 'Enter picks the member');
  await a.keyboard.type('pizza');
  await a.keyboard.press('Enter');
  await a.locator('.search-panel .search-result').first().waitFor();
  let texts = await resultTexts(a);
  check(texts.length === 1 && texts[0].startsWith('pizza night?'), `from: + words finds bob's message (${texts.join(' | ')})`);
  check((await a.locator('.search-panel h5').textContent()) === '1 result', 'with a count');
  check(texts[0].includes(`@${alice.name}`), 'mentions show as names');
  await shot(a, '03-results');

  await searchFor(a, 'pizza');
  texts = await resultTexts(a);
  check(texts.length === 3, `words alone search every channel alice can see, #secret too (${texts.length})`);
  await a.locator('.search-panel-sort-buttons button', { hasText: 'Oldest' }).click();
  await a.waitForFunction(() => document.querySelectorAll('.search-panel .search-result').length > 0 &&
    document.querySelector('.search-panel .search-result .dm-message-content').textContent.startsWith('pizza night'));
  check(true, 'Oldest puts the first one first');

  await searchFor(a, 'has:link');
  texts = await resultTexts(a);
  check(texts.length === 1 && texts[0].includes('example.com'), 'has:link');
  await searchFor(a, `mentions:${alice.name}`);
  check((await resultTexts(a)).length === 1, 'mentions:');
  await searchFor(a, 'from:nobody-at-all');
  check((await a.locator('.search-panel .error-text').textContent()).includes('No member called nobody-at-all'), 'an unknown member is reported');

  const input = a.locator('.guild-search-input');
  await input.fill('');
  await input.type('treasure in:ran');
  await a.locator('.guild-search-suggestion', { hasText: 'random' }).waitFor();
  await a.keyboard.press('Tab');
  check(await input.inputValue() === 'treasure in:random ', 'Tab completes the channel');
  await a.keyboard.press('Enter');
  await a.locator('.search-panel .search-result').first().waitFor();
  check((await a.locator('.search-result-channel').first().textContent()).includes('random'), 'the result names its channel');
  await a.locator('.search-panel .pinned-message-jump').first().click();
  await a.waitForURL(`**/guild/${guild.id}/${random.id}`);
  const row = a.locator('.each-dm-message-wrapper', { hasText: 'the treasure map is under the old oak' });
  await row.waitFor({ timeout: 20000 });
  await a.waitForFunction(() => {
    const el = [...document.querySelectorAll('.each-dm-message-wrapper')].find((r) => r.textContent.includes('treasure map'));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = document.querySelector('.message-scroller').getBoundingClientRect();
    return r.top >= s.top && r.bottom <= s.bottom;
  }, null, { timeout: 20000 });
  check(true, 'Jump opens the other channel, loads older history and scrolls to it');
  check(await row.evaluate((el) => el.classList.contains('jump-highlight')), 'and highlights it');
  check(await a.locator('.search-panel').count() === 1, 'the results stay open on a computer');
  await shot(a, '04-jumped');
  await a.keyboard.press('Escape');
  await a.mouse.click(400, 400);
  check(await a.locator('.search-panel').count() === 0, 'a click outside closes the results');

  // Bob can't see #secret, so its messages aren't found.
  await bob.page.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await bob.page.waitForSelector('#dm-input');
  await searchFor(bob.page, 'recipe');
  check(await bob.page.locator('.search-panel .pins-panel-empty').count() === 1, "bob doesn't find #secret's message");

  // ---- Phone ----
  console.log('phone');
  await c.goto(`${BASE}/guild/${guild.id}/${general.id}`);
  await c.waitForSelector('#dm-input');
  await c.locator('.channel-header .search-button').click();
  await c.locator('.search-panel.mobile .guild-search-input').waitFor();
  const full = await c.locator('.search-panel').boundingBox();
  const viewport = c.viewportSize();
  check(full.width === viewport.width && full.height >= viewport.height - 1, 'search is full screen on a phone');
  await c.locator('.guild-search-input').tap();
  await c.keyboard.type('treasure');
  await c.keyboard.press('Enter');
  await c.locator('.search-panel .search-result').first().waitFor();
  await shot(c, '05-phone-results');
  await c.locator('.search-panel .pinned-message-jump').first().tap();
  check(await c.locator('.search-panel').count() === 0, 'Jump closes it on a phone');
  await c.locator('.each-dm-message-wrapper', { hasText: 'the treasure map' }).waitFor({ timeout: 20000 });
  check(true, 'and shows the message');
  await shot(c, '06-phone-jumped');

  // Messages sent and edited now are found.
  await send(a, 'a brand new zeppelin');
  await c.locator('.channel-header .search-button').tap();
  check(await c.locator('.guild-search-input').inputValue() === 'treasure', 'reopening keeps the last search');
  await c.locator('.guild-search-input').fill('');
  await c.keyboard.type('zeppelin');
  await c.keyboard.press('Enter');
  await c.locator('.search-panel .search-result').first().waitFor();
  check(true, 'a message sent a moment ago is found');
  console.log('search: ok');
} catch (err) {
  console.error('search: FAILED', err.message.split('\n')[0]);
  for (const context of browser.contexts()) {
    for (const [i, page] of context.pages().entries()) await shot(page, `failed-${browser.contexts().indexOf(context)}-${i}`);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
