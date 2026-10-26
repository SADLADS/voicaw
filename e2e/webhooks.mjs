// Webhooks in a real browser: make one in a channel's settings (name, picture, copy its URL),
// post to it the way Discord clients do (JSON with an embed, multipart with files, edit and
// delete by token) and watch the messages arrive live, on a computer and a phone.
//   node e2e/serve.mjs &   then   node e2e/webhooks.mjs [screenshot dir]
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const png = (color, width, height) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice', { viewport: { width: 1100, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const a = alice.page;

  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Hooks');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');

  // Channel settings → Webhooks → New Webhook, then rename it and give it a picture.
  await a.click('button[aria-label="Edit general"]');
  await a.click('[role="tab"]:has-text("Webhooks")');
  await a.click('button:has-text("New Webhook")');
  await a.fill('input[aria-label="Webhook name"]', 'Deploy Bot');
  await a.setInputFiles('input[aria-label="Webhook picture"]', { name: 'bot.png', mimeType: 'image/png', buffer: await png('#e0a030', 300, 300) });
  await a.click('.image-cropper button:has-text("Apply")'); // the cropper (see avatarcrop.mjs)
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  await a.click('button:has-text("Save Changes")');
  await a.waitForSelector('.webhook-name:has-text("Deploy Bot")');
  await a.waitForFunction(() => document.querySelector('.webhook-summary .webhook-avatar')?.src.includes('/profile-pics/webhooks/'));
  await a.click('button:has-text("Copy Webhook URL")');
  await a.waitForSelector('text=Copied!');
  const url = await a.evaluate(() => navigator.clipboard.readText());
  if (!url.startsWith(`${BASE}/api/webhooks/`)) throw new Error(`unexpected webhook URL ${url}`);
  await shot(a, 'webhook-settings');
  console.log('made a webhook in the UI:', url.replace(/[^/]+$/, '<token>'));
  await a.keyboard.press('Escape');

  // A Discord-style JSON post with an embed, straight to the copied URL.
  const post = (path, init) => fetch(`${url}${path}`, init);
  let res = await post('?wait=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Deploy to **production** finished @everyone',
      embeds: [{
        title: 'voicaw #1234', url: 'https://example.com/builds/1234', color: 0x57F287,
        description: 'All checks passed in `3m 12s`.\n- server ✅\n- client ✅',
        // A big picture (1280 px) as the small icons and the thumbnail, as sites send them.
        author: { name: 'CI', icon_url: `${BASE}/default.png` },
        thumbnail: { url: `${BASE}/default.png` },
        fields: [
          { name: 'Branch', value: 'dev', inline: true },
          { name: 'Commit', value: '`b50f16b`', inline: true },
          { name: 'Changes', value: 'Spellcheck, webhooks' },
        ],
        footer: { text: 'Deploys', icon_url: `${BASE}/default.png` }, timestamp: new Date().toISOString(),
      }],
    }),
  });
  if (res.status !== 200) throw new Error(`execute: ${res.status} ${await res.text()}`);
  const first = await res.json();
  await a.waitForSelector('.embed .embed-title:has-text("voicaw #1234")', { timeout: 10000 });
  await a.waitForSelector('.message-author:has-text("Deploy Bot") + .app-tag');
  console.log('embed message arrived live, as', first.author.username);

  // The icons stay icon-sized, the footer's beside its text, the thumbnail within 80 px.
  await a.waitForFunction(() => [...document.querySelectorAll('.embed-author-icon, .embed-footer-icon, .embed-thumbnail')].every((img) => img.complete && img.naturalWidth));
  const sizes = await a.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const footer = box('.embed-footer'), footerIcon = box('.embed-footer-icon');
    return {
      author: [box('.embed-author-icon').width, box('.embed-author-icon').height],
      footer: [footerIcon.width, footerIcon.height],
      footerOneLine: footer.height < 30,
      thumbnail: [box('.embed-thumbnail').width, box('.embed-thumbnail').height],
    };
  });
  if (sizes.author.join() !== '24,24' || sizes.footer.join() !== '20,20' || !sizes.footerOneLine
    || sizes.thumbnail.some((n) => n > 80)) throw new Error(`embed icon sizes ${JSON.stringify(sizes)}`);
  console.log('icons 24 and 20 px, footer on one line, thumbnail', sizes.thumbnail.join('x'));

  // Multipart: payload_json, a picture (also the embed's image) and a text file.
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'Chart Bot', embeds: [{ title: 'Load', image: { url: 'attachment://load.png' } }] }));
  form.append('files[0]', new Blob([await png('#3070e0', 480, 200)], { type: 'image/png' }), 'load.png');
  form.append('files[1]', new Blob(['all good\n'], { type: 'text/plain' }), 'build log.txt');
  res = await post('', { method: 'POST', body: form });
  if (res.status !== 204) throw new Error(`multipart: ${res.status} ${await res.text()}`);
  await a.waitForSelector('.message-file-name:has-text("build_log.txt")', { timeout: 10000 });
  await a.waitForSelector('.embed-image');
  console.log('files arrived, under the name it asked for');

  // Edit the first one by token.
  res = await post(`/messages/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Deploy to **production** finished (edited)' }) });
  if (res.status !== 200) throw new Error(`edit: ${res.status}`);
  await a.waitForSelector('.dm-message-content:has-text("finished (edited)")', { timeout: 10000 });
  await a.waitForTimeout(500);
  await shot(a, 'webhook-messages');
  if (shots) await a.locator('.message-list, .dm-message-wrapper').first().screenshot({ path: `${shots}/webhook-messages-close.png` });

  // A phone.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(`${BASE}/`);
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.click('button:has-text("Login")');
  await p.waitForSelector('#dm-main', { timeout: 20000 });
  await p.goto(a.url());
  await p.waitForSelector('.embed', { timeout: 20000 });
  await p.evaluate(() => document.querySelector('.embed')?.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(500);
  await shot(p, 'webhook-phone');

  // Delete by token: gone from the channel.
  res = await post(`/messages/${first.id}`, { method: 'DELETE' });
  if (res.status !== 204) throw new Error(`delete: ${res.status}`);
  await a.waitForSelector('.embed-title:has-text("voicaw #1234")', { state: 'detached', timeout: 10000 });
  console.log('webhooks e2e: ok');
} catch (err) {
  console.error('webhooks e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
