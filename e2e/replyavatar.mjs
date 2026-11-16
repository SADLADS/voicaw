// Replies to a webhook's messages show that message's own picture and name in the reply
// snippet: a webhook posts twice with different names and pictures (avatar_url), someone
// replies to each in the app, and each snippet has its parent's, live and after a reload.
//   node e2e/serve.mjs &   then   node e2e/replyavatar.mjs [screenshot dir]
import { launchChrome, signUp, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 } });
  const a = alice.page;
  const api = (method, path, body) => a.evaluate(async ([m, p, b]) => {
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
    return res.json();
  }, [method, path, body]);

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Hooks');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  const channelId = a.url().match(/(\d+)\/?(?:\?.*)?$/)[1];
  const hook = await api('POST', `/channels/${channelId}/webhooks`, { name: 'Captain Hook' });

  const pictures = { Alpha: `${BASE}/logo192.png`, Beta: `${BASE}/apple-touch-icon.png` };
  for (const [username, avatar_url] of Object.entries(pictures)) {
    const res = await fetch(`${BASE}/api/webhooks/${hook.id}/${hook.token}?wait=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `from ${username}`, username, avatar_url }),
    });
    if (res.status !== 200) throw new Error(`execute: ${res.status}`);
    await a.waitForSelector(`.message-author:has-text("${username}")`, { timeout: 10000 });
  }

  // Reply to each from the hover menu.
  for (const username of Object.keys(pictures)) {
    const row = a.locator('.each-dm-message-wrapper', { hasText: `from ${username}` }).first();
    await row.hover();
    await row.locator('.message-menu button:has(svg[data-icon="reply"])').click();
    await a.keyboard.type(`re ${username}`);
    await a.keyboard.press('Enter');
    await a.waitForSelector(`.each-dm-message-wrapper:has-text("re ${username}") .reply-snippet`, { timeout: 10000 });
  }

  const snippets = () => a.evaluate((names) => names.map((name) => {
    const row = [...document.querySelectorAll('.each-dm-message-wrapper')].find((r) => r.textContent.includes(`re ${name}`));
    const img = row?.querySelector('.reply-snippet img.reply-avatar');
    return { name, author: row?.querySelector('.reply-author')?.textContent, src: img?.getAttribute('src'), loaded: Boolean(img?.complete && img.naturalWidth) };
  }), Object.keys(pictures));

  const checkAll = async (when) => {
    await a.waitForFunction(() => [...document.querySelectorAll('.reply-snippet img.reply-avatar')].every((img) => img.complete));
    for (const s of await snippets()) {
      check(s.author === s.name, `${when}: reply to ${s.name} names ${s.name} ("${s.author}")`);
      check(s.src === pictures[s.name] && s.loaded, `${when}: reply to ${s.name} shows its picture (${s.src})`);
    }
  };
  await checkAll('live');
  await shot(a, 'replies');
  await a.reload();
  await a.waitForSelector('.each-dm-message-wrapper:has-text("re Beta") .reply-snippet', { timeout: 20000 });
  await checkAll('after reload');
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('replies to webhook messages show their pictures');
