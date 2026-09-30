// Guilds in a real browser: create one, invite someone through the UI, chat live, unread
// markers, channels and categories, the member list, and the mobile layout.
//   node e2e/serve.mjs &   then   node e2e/guilds.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function sendInChannel(page, text) {
  await page.click('#dm-input');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const a = alice.page;
  const b = bob.page;

  // Alice creates a guild from the rail's "+".
  await a.click('button[aria-label="Add a guild"]');
  await a.fill('#new-guild-name', 'Test Guild');
  await a.click('button:has-text("Create")');
  await a.waitForSelector('.guild-header-name:has-text("Test Guild")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await a.waitForSelector('#dm-input');
  console.log('created guild, opened #general:', a.url());

  // Invite link from the header menu.
  await a.click('.guild-header-button');
  await a.click('text=Invite People');
  const link = await a.inputValue('#invite-link').then(async (v) => v || (await a.waitForFunction(() => document.querySelector('#invite-link')?.value).then(() => a.inputValue('#invite-link'))));
  console.log('invite link:', link);
  await a.keyboard.press('Escape');

  // Bob opens it and joins.
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await b.waitForSelector('text=invited you to join');
  await shot(b, 'invite-page');
  await b.click('button:has-text("Accept invite")');
  await b.waitForSelector('.guild-channel.active:has-text("general")');
  console.log('bob joined:', b.url());

  // Live chat both ways.
  await sendInChannel(a, 'hello guild');
  await b.waitForSelector('.dm-message-content:has-text("hello guild")', { timeout: 10000 });
  await sendInChannel(b, 'hi alice');
  await a.waitForSelector('.dm-message-content:has-text("hi alice")', { timeout: 10000 });
  console.log('messages delivered live both ways');

  // Member list shows both, online.
  await a.waitForSelector(`.member-list .member-row:has-text("${bob.name}")`);
  const onlineCount = await a.textContent('.member-group');
  console.log('member list:', onlineCount);

  // Owner creates a category and a channel in it.
  await a.click('.guild-header-button');
  await a.click('text=Create Category');
  await a.fill('#category-name', 'Fun Stuff');
  await a.click('button:has-text("Create category")');
  await a.waitForSelector('.guild-category-toggle:has-text("Fun Stuff")');
  await a.hover('.guild-category-header:has-text("Fun Stuff")');
  await a.click('button[aria-label="Create channel in Fun Stuff"]');
  await a.fill('#channel-name', 'Memes And Things');
  await a.fill('#channel-topic', 'Post your best memes here');
  await a.click('button:has-text("Create channel")');
  await a.waitForSelector('.guild-channel.active:has-text("memes-and-things")');
  await a.waitForSelector('.channel-header-topic:has-text("Post your best memes")');
  // Bob sees it appear live.
  await b.waitForSelector('.guild-channel:has-text("memes-and-things")');
  console.log('category + channel created, visible to bob live');

  // Unread: Bob posts in #memes while Alice is in #general → bold channel for Alice.
  await a.click('.guild-channel-link:has-text("general")');
  await a.waitForSelector('.guild-channel.active:has-text("general")');
  await b.click('.guild-channel-link:has-text("memes-and-things")');
  await b.waitForSelector('#dm-input');
  await sendInChannel(b, 'first meme');
  await a.waitForSelector('.guild-channel.unread:has-text("memes-and-things")', { timeout: 10000 });
  console.log('unread channel marked');
  // Alice on DMs: the rail's guild dot shows.
  await a.click('a[aria-label="Direct Messages"]');
  await sendInChannel(b, 'second meme');
  await a.waitForSelector('.rail-guilds .dot.visible', { timeout: 10000 });
  console.log('rail unread dot shown');
  // Opening the channel clears it.
  await a.click('.rail-guild');
  await a.click('.guild-channel-link:has-text("memes-and-things")');
  await a.waitForSelector('.dm-message-content:has-text("second meme")');
  await a.waitForSelector('.rail-guilds .dot.visible', { state: 'detached', timeout: 10000 });
  console.log('unread cleared after reading');

  // Reactions (plain emoji) and a reply.
  await a.hover('.each-dm-message-wrapper:has-text("second meme")');
  await a.click('.each-dm-message-wrapper:has-text("second meme") button[aria-label="Add reaction"]');
  await a.waitForSelector('.emoji-picker');
  await a.fill('.emoji-picker-search input, input.emoji-picker-search', 'joy');
  await a.click('.emoji-picker-item >> nth=0');
  await b.waitForSelector('.each-dm-message-wrapper:has-text("second meme") .reaction-chip', { timeout: 10000 });
  console.log('reaction delivered');

  await shot(a, 'desktop-channel');

  // Owner menu and settings dialog render.
  await a.click('.guild-header-button');
  await shot(a, 'desktop-menu');
  await a.click('text=Guild Settings');
  await a.waitForSelector('.guild-settings-dialog');
  await shot(a, 'desktop-settings');
  await a.click('.settings-tab:has-text("Invites")');
  await a.waitForSelector('.guild-settings-code');
  await shot(a, 'desktop-settings');
  await a.keyboard.press('Escape');

  // Bob's member card on Alice's side: kick option exists (not used).
  await a.click(`.member-row:has-text("${bob.name}")`);
  await a.waitForSelector('.member-card button:has-text("Kick")');
  await shot(a, 'desktop-member-card');
  await a.click('.channel-header-name');

  // Mobile: a phone user joins through the same link.
  const carol = await signUp(browser, 'carol', devices['Pixel 7']);
  const c = carol.page;
  await c.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await c.click('button:has-text("Accept invite")');
  await c.waitForSelector('#dm-input');
  await c.waitForTimeout(800);
  await shot(c, 'mobile-chat');
  await c.click('button[aria-label="Show member list"]');
  await c.waitForSelector('.member-list');
  await shot(c, 'mobile-members');
  await c.click('button[aria-label="Close members"]');
  // Slide back to the channel list.
  await c.evaluate(() => document.querySelector('.main-wrapper').scrollTo({ left: 0, behavior: 'instant' }));
  await c.waitForTimeout(500);
  await shot(c, 'mobile-channels');

  // Bob leaves: Alice's member list drops him.
  await b.click('.guild-header-button');
  await b.click('text=Leave Guild');
  await b.click('.vc-dialog button:has-text("Leave Guild")');
  await b.waitForURL(/\/dm/);
  await a.waitForSelector(`.member-row:has-text("${bob.name}")`, { state: 'detached', timeout: 10000 });
  console.log('leave works; bob gone from member list');

  console.log('guilds e2e: ok');
} catch (err) {
  console.error('guilds e2e: FAILED', err.message.split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
