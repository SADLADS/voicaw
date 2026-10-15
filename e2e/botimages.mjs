// Pictures a bot or webhook sends (Discord's attachments) open in the image viewer, like
// people's: click → viewer (name, size, arrows through the message's pictures), Escape closes
// it; Ctrl+click still opens a new tab; on a phone a tap opens the viewer too.
//   node e2e/serve.mjs &   then   node e2e/botimages.mjs [screenshot dir]
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const png = (color, width, height) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

// A new account's guild with a webhook message holding two pictures (sent the way discord.py
// sends files, as octet-stream); resolves to the page.
async function guildWithPictures(browser, name, contextOptions) {
  const user = await signUp(browser, name, { ...contextOptions, permissions: ['clipboard-read', 'clipboard-write'] });
  const { page } = user;
  await page.click('button[aria-label="Add a guild"]');
  await page.fill('#new-guild-name', 'Pictures');
  await page.click('button:has-text("Create")');
  await page.waitForSelector('.guild-channel.active:has-text("general")');
  await page.click('button[aria-label="Edit general"]');
  await page.click('[role="tab"]:has-text("Webhooks")');
  await page.click('button:has-text("New Webhook")');
  await page.click('button:has-text("Copy Webhook URL")');
  await page.waitForSelector('text=Copied!');
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press('Escape');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: 'two tweets' }));
  form.append('files[0]', new Blob([await png('#3070e0', 600, 400)], { type: 'application/octet-stream' }), 'first.png');
  form.append('files[1]', new Blob([await png('#e05030', 300, 500)], { type: 'application/octet-stream' }), 'second.png');
  const res = await fetch(url, { method: 'POST', body: form });
  if (res.status !== 204) throw new Error(`post: ${res.status} ${await res.text()}`);
  await page.waitForSelector('.message-file-image img[alt="second.png"]', { timeout: 10000 });
  return { page, user };
}

const browser = await launchChrome();
try {
  const { page: a, user: alice } = await guildWithPictures(browser, 'alice', { viewport: { width: 1100, height: 800 } });
  const pagesBefore = a.context().pages().length;
  const channelUrl = a.url();
  await a.click('.message-file-image img[alt="second.png"]');
  await a.waitForSelector('.image-viewer[aria-label="second.png"]');
  if (a.context().pages().length !== pagesBefore) throw new Error('a click opened a new tab');
  await shot(a, 'viewer');
  await a.keyboard.press('ArrowLeft');
  await a.waitForSelector('.image-viewer[aria-label="first.png"]');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.image-viewer', { state: 'detached' });
  if (a.url() !== channelUrl) throw new Error(`Escape left the channel: ${a.url()}`);
  console.log('click opens the viewer, arrows step through the message, Escape closes it');

  const [tab] = await Promise.all([
    a.context().waitForEvent('page'),
    a.click('.message-file-image img[alt="first.png"]', { modifiers: ['Control'] }),
  ]);
  await tab.waitForLoadState();
  if (!tab.url().endsWith('/first.png')) throw new Error(`Ctrl+click opened ${tab.url()}`);
  if (await a.$('.image-viewer')) throw new Error('Ctrl+click also opened the viewer');
  await tab.close();
  console.log('Ctrl+click still opens the picture in a new tab');

  // Phone: the same account logs in and opens the channel.
  const p = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await p.goto(`${BASE}/`);
  await p.fill('input[placeholder="Username"]', alice.name);
  await p.fill('input[placeholder="Password"]', alice.password);
  await p.click('button:has-text("Login")');
  await p.waitForSelector('#dm-main', { timeout: 20000 });
  await p.goto(a.url());
  await p.waitForSelector('.message-file-image img[alt="first.png"]', { timeout: 20000 });
  await p.tap('.message-file-image img[alt="first.png"]');
  await p.waitForSelector('.image-viewer[aria-label="first.png"]');
  await shot(p, 'viewer-phone');
  console.log('phone: a tap opens the viewer');
  console.log('OK');
} finally {
  await browser.close();
}
