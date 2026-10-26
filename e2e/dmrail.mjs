// The rail's unread chats: the bird stays the DM button, and under it each chat with unread
// messages gets its newest sender's picture (newest first) with how many are unread (live, and
// after a reload), opening that chat when clicked and going once it's read; the separator moves
// down under them; a group shows its own picture, or its members' two as in the DM list; on a
// phone too (opening the chat pane).
//   node e2e/serve.mjs &   then   node e2e/dmrail.mjs [screenshot dir]
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { launchChrome, signUp, openChat, send, devices, BASE, makeFriends } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });

const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (!res.ok) throw new Error(`${m} ${p}: ${res.status}`);
  return res.json();
}, [method, path, body]);

const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`  ok: ${what}`);
};

// The rail as it stands: whether the bird is there, then each unread chat's sender (from its
// label) and count, in order, and whether the separator comes after them.
const rail = (page) => page.evaluate(() => {
  const sidebar = document.querySelector('.sidebar');
  const chats = [...sidebar.querySelectorAll('.rail-unread-chat')];
  const separator = sidebar.querySelector('.rail-separator');
  return {
    bird: !!sidebar.querySelector('a[aria-label="Direct Messages"] .rail-logo'),
    chats: chats.map((c) => ({
      name: c.querySelector('a').getAttribute('aria-label').replace(/^.* from /, ''),
      count: c.querySelector('.rail-mention-badge')?.textContent,
      picture: !!c.querySelector('a img'),
    })),
    separatorAfter: !separator || chats.every((c) => c.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});
const waitForChats = (page, names) => page.waitForFunction((want) => {
  const got = [...document.querySelectorAll('.sidebar .rail-unread-chat a')].map((a) => a.getAttribute('aria-label').replace(/^.* from /, ''));
  return got.join('|') === want.join('|');
}, names, { timeout: 10000 });
const picture = (page, name) => page.locator(`.sidebar .rail-unread-chat a[aria-label$="from ${name}"]`);

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const carol = await signUp(browser, 'carol');
  const bob = await signUp(browser, 'bob');
  const b = bob.page;

  // Bob waits in a guild of his own, so no chat is open.
  const own = await api(b, 'POST', '/guilds', { name: 'Elsewhere' });
  const ownId = own.id ?? own.guild?.id;
  await b.goto(`${BASE}/guild/${ownId}`);
  await b.waitForSelector('#dm-input');
  let state = await rail(b);
  check(state.bird && state.chats.length === 0, 'nothing unread: the bird alone');

  await openChat(alice.page, bob.id);
  await send(alice.page, 'hi from alice');
  await send(alice.page, 'are you there?');
  await waitForChats(b, [alice.name]);
  await b.waitForFunction(() => document.querySelector('.sidebar .rail-unread-chat .rail-mention-badge')?.textContent === '2', null, { timeout: 10000 });
  state = await rail(b);
  check(state.bird && state.chats[0].picture && state.chats[0].count === '2', "a DM: the bird stays, the sender's picture under it with 2, live");
  const box = await picture(b, alice.name).boundingBox();
  check(Math.round(box.width) === 48 && Math.round(box.height) === 48, 'the picture is a 48px icon, like a guild');
  check(state.separatorAfter, 'the separator is under it');
  if (dir) await b.locator('.sidebar').screenshot({ path: `${dir}/rail-unread.png` });

  await openChat(carol.page, bob.id);
  await send(carol.page, 'hi from carol');
  await waitForChats(b, [carol.name, alice.name]);
  check(true, 'a newer DM from someone else: their picture first, the other under it');

  await b.reload();
  await b.waitForSelector('#dm-input');
  await waitForChats(b, [carol.name, alice.name]);
  check(true, 'after a reload: the same, newest first');
  if (dir) await b.locator('.sidebar').screenshot({ path: `${dir}/rail-unread-two.png` });

  await picture(b, carol.name).click();
  await b.waitForURL(`${BASE}/dm/${carol.id}`);
  await b.waitForSelector('#dm-input');
  check(true, "clicking a picture opens that sender's chat");
  await waitForChats(b, [alice.name]);
  check(true, 'reading it: its picture goes, the other stays');

  await picture(b, alice.name).click();
  await b.waitForURL(`${BASE}/dm/${alice.id}`);
  await waitForChats(b, []);
  state = await rail(b);
  check(state.bird, 'all read: the bird alone again');

  // A group: its members' two pictures (no sender's), then its own picture once it has one.
  await makeFriends(alice, bob, carol);
  const a = alice.page;
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bob.name}") input`);
  await a.check(`.user-picker-row:has-text("${carol.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupPath = new URL(a.url()).pathname;
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await b.goto(`${BASE}/guild/${ownId}`);
  await b.waitForSelector('#dm-input');
  await send(a, 'hi group');
  await waitForChats(b, [`${alice.name} in Trip`]);
  const group = picture(b, `${alice.name} in Trip`);
  check(await group.getAttribute('href') === groupPath, 'a group: its icon opens the group');
  await b.waitForFunction(() => document.querySelectorAll('.sidebar .rail-group .group-avatar img.group-avatar-img').length === 2, null, { timeout: 10000 });
  check(true, "no group picture: the members' two pictures, as in the DM list");
  if (dir) await b.locator('.sidebar').screenshot({ path: `${dir}/rail-group-members.png` });

  if (!(await a.$('.group-members'))) await a.click('.group-members-button');
  await a.click('.group-action:has-text("Change picture")');
  const halves = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }).png().toBuffer();
  await a.setInputFiles('input[aria-label="Choose a picture for the group"]', { name: 'blue.png', mimeType: 'image/png', buffer: halves });
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('img.group-picture-preview');
  await a.click('.vc-dialog button:has-text("Save")');
  await a.waitForSelector('.message-system:has-text("You changed the group\'s picture.")', { timeout: 20000 });
  await send(a, 'look, a picture');
  await b.waitForSelector('.sidebar .rail-group img.group-picture', { timeout: 20000 });
  const groupBox = await group.boundingBox();
  check(!(await b.$('.sidebar .rail-group .group-avatar')) && Math.round(groupBox.width) === 48, "with a picture: the group's own, 48px");
  if (dir) await b.locator('.sidebar').screenshot({ path: `${dir}/rail-group-picture.png` });
  await group.click();
  await b.waitForURL(`${BASE}${groupPath}`);
  await waitForChats(b, []);
  check(true, 'clicking it opens the group, and it goes');

  // A phone: the rail beside a guild's channel list.
  const dave = await signUp(browser, 'dave', { ...devices['Pixel 7'] });
  const p = dave.page;
  const daves = await api(p, 'POST', '/guilds', { name: 'Phone' });
  await p.goto(`${BASE}/guild/${daves.id ?? daves.guild?.id}`);
  await openChat(alice.page, dave.id);
  await send(alice.page, 'hi dave');
  await waitForChats(p, [alice.name]);
  check((await rail(p)).bird, 'phone: the picture under the bird too');
  // A quick flick right shows the list (and the rail), where the picture is.
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }] });
  await touch('touchStart', 40);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', 40 + i * 50); await p.waitForTimeout(16); }
  await touch('touchEnd');
  await cdp.detach();
  await p.waitForTimeout(600);
  if (dir) await p.screenshot({ path: `${dir}/rail-phone.png` });
  await picture(p, alice.name).click();
  await p.waitForURL(`${BASE}/dm/${alice.id}`);
  await p.waitForFunction(() => {
    const box = document.querySelector('#dm-input')?.getBoundingClientRect();
    return box && box.left >= 0 && box.right <= window.innerWidth + 1;
  }, null, { timeout: 5000 });
  check(true, 'phone: clicking the picture opens the chat, its pane in view');
  await waitForChats(p, []);
  if (dir) await p.screenshot({ path: `${dir}/rail-phone-opened.png` });
  console.log('dmrail: ok');
} catch (err) {
  console.error('dmrail: FAILED', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
