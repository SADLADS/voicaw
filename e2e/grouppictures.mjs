// Group DM pictures in real browsers: Ann picks one for "Trip" from the members panel (the
// cropper opens over the dialog, Escape closes only it, Apply previews, Save stores it); the
// header and list show it (the middle square, decrypted on the device) and the API only has
// ciphertext; Bea sees it live with a line in the timeline; Cal renames the group and the
// picture stays; Dan (a phone), added later, sees it; it survives a reload; Bea removes it and
// everyone's back to the members' pictures.
//   node e2e/serve.mjs &   then   node e2e/grouppictures.mjs [screenshot dir]
import { mkdirSync } from 'fs';
import sharp from 'sharp';
import { launchChrome, signUp, devices, BASE, makeFriends } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = async (page, name) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// 400×200: the left half red, the right half blue. Its middle square is half and half.
const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const PICTURE = {
  name: 'halves.png',
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }]).png().toBuffer(),
};

// (On a phone the list is behind the open chat: present, not visible.)
const listRow = (page, name) => page.waitForSelector(`.dm-group:has-text("${name}")`, { timeout: 20000, state: 'attached' });
const openGroup = async (page, name) => {
  await page.goto(`${BASE}/dm`);
  const href = await (await listRow(page, name)).getAttribute('href');
  await page.goto(`${BASE}${href}`);
  await page.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
};
const showMembers = async (page) => {
  if (!(await page.$('.group-members'))) await page.click('.group-members-button');
};
// The colours at the left and right middle of a shown picture, as 'red' / 'blue' / r,g,b.
const colours = (page, selector) => page.$eval(selector, async (img) => {
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const at = (x) => {
    const [r, g, b] = ctx.getImageData(Math.floor(x * canvas.width), Math.floor(canvas.height / 2), 1, 1).data;
    return r > 200 && g < 60 && b < 60 ? 'red' : b > 200 && r < 60 && g < 60 ? 'blue' : `${r},${g},${b}`;
  };
  return { left: at(0.25), right: at(0.75), size: canvas.width };
});
// What the API returns for the group's picture.
const apiPicture = (page, groupId) => page.evaluate(async (id) => {
  const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
  const group = await (await fetch(`/api/group-dms/${id}`, { headers })).json();
  if (!group.picture_id) return { group };
  const res = await fetch(`/api/group-dms/${id}/pictures/${group.picture_id}`, { headers });
  return { group, status: res.status, data: (await res.json()).data };
}, groupId);

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  const cal = await signUp(browser, 'cal');
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const [a, b, c, d] = [ann.page, bea.page, cal.page, dan.page];
  await makeFriends(ann, bea, cal, dan);
  for (const [who, page] of [['ann', a], ['bea', b], ['cal', c], ['dan', d]]) {
    page.on('console', (m) => {
      const text = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/404|deprecated|abort|Too Many/i.test(text)) console.log(`[${who} ${m.type()}]`, text.slice(0, 200));
    });
    page.on('pageerror', (e) => console.log(`[${who}] page error:`, e.message));
  }

  // Ann makes "Trip" with Bea and Cal.
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  const groupId = a.url().split('/dm/g/')[1];
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  check(!(await a.$('.group-dm-header-picture')) && Boolean(await a.$('.dm-group .group-avatar-img')), 'no picture yet: the list shows the members');
  await openGroup(b, 'Trip');

  // Ann picks a picture: the cropper over the dialog, Escape closes only the cropper.
  await showMembers(a);
  await a.click('.group-action:has-text("Change picture")');
  await a.waitForSelector('.vc-dialog:has-text("Group Picture")');
  await a.setInputFiles('input[aria-label="Choose a picture for the group"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await shot(a, '01-cropper');
  await a.keyboard.press('Escape');
  await a.waitForSelector('.image-cropper', { state: 'detached' });
  check(Boolean(await a.$('.vc-dialog:has-text("Group Picture")')), 'Escape closes only the cropper');
  await a.setInputFiles('input[aria-label="Choose a picture for the group"]', PICTURE);
  await a.waitForSelector('.image-cropper .image-cropper-frame img[style*="left"]');
  await a.click('.image-cropper button:has-text("Apply")');
  await a.waitForSelector('img.group-picture-preview');
  await shot(a, '02-preview');
  await a.click('.vc-dialog button:has-text("Save")');
  await a.waitForSelector('.message-system:has-text("You changed the group\'s picture.")', { timeout: 20000 });
  check(true, 'ann: "You changed the group\'s picture." in the timeline');
  await a.waitForSelector('.group-dm-header-picture', { timeout: 20000 });
  await a.waitForSelector('.dm-group img.group-picture', { timeout: 20000 });
  const shown = await colours(a, '.group-dm-header-picture');
  check(shown.left === 'red' && shown.right === 'blue' && shown.size === 200, `header and list show the middle square (${JSON.stringify(shown)})`);
  await shot(a, '03-ann-with-picture');

  // The API has only ciphertext (not a WebP, which starts "RIFF", base64 "UklGR").
  const stored = await apiPicture(a, groupId);
  check(stored.status === 200 && stored.data.startsWith('v1.') && !stored.data.slice(3).startsWith('UklGR'), 'the API only has the picture encrypted');

  // Bea, with the group open, sees it live.
  await b.waitForSelector(`.message-system:has-text("${ann.name} changed the group's picture.")`, { timeout: 20000 });
  await b.waitForSelector('.group-dm-header-picture', { timeout: 20000 });
  check((await colours(b, '.dm-group img.group-picture')).left === 'red', 'bea sees the picture live: line, header and list');
  await shot(b, '04-bea-live');

  // Cal renames the group: the picture stays.
  await openGroup(c, 'Trip');
  await showMembers(c);
  await c.click('.group-action:has-text("Rename")');
  await c.fill('.vc-dialog input[aria-label="Group name"]', 'Plans');
  await c.click('.vc-dialog button:has-text("Save")');
  await c.waitForSelector('.message-system:has-text("You renamed the group to “Plans”.")', { timeout: 20000 });
  await a.waitForSelector('.group-dm-title:text-is("Plans")', { timeout: 20000 });
  await a.waitForTimeout(500);
  check(Boolean(await a.$('.group-dm-header-picture')) && (await apiPicture(a, groupId)).group.picture_id === stored.group.picture_id, 'renaming keeps the picture');

  // Ann adds Dan (a phone): he sees it.
  await showMembers(a);
  await a.click('button:has-text("Add people")');
  await a.check(`.user-picker-row:has-text("${dan.name}") input`);
  await a.click('.vc-dialog button:has-text("Add")');
  await a.waitForSelector('.vc-dialog', { state: 'detached', timeout: 20000 });
  await d.goto(`${BASE}/dm`);
  await d.waitForSelector('.dm-group:has-text("Plans") img.group-picture', { timeout: 20000 });
  check((await colours(d, '.dm-group img.group-picture')).right === 'blue', 'dan (added later, a phone) sees the picture in his list');
  await shot(d, '05-dan-list');
  await openGroup(d, 'Plans');
  await d.waitForSelector('.group-dm-header-picture', { timeout: 20000 });
  check(!(await d.$('.message-system:has-text("changed the group\'s picture")')), "dan doesn't see the change from before he was in");
  await shot(d, '06-dan-group');

  // A reload keeps it.
  await a.reload();
  await a.waitForSelector('.group-dm-header-picture', { timeout: 20000 });
  check(true, 'a reload keeps it');

  // Bea removes it.
  await showMembers(b);
  await b.click('.group-action:has-text("Change picture")');
  await b.waitForSelector('img.group-picture-preview');
  await b.click('.vc-dialog button:has-text("Remove")');
  await b.waitForSelector('.group-picture-empty');
  await b.click('.vc-dialog button:has-text("Save")');
  await b.waitForSelector('.message-system:has-text("You removed the group\'s picture.")', { timeout: 20000 });
  await a.waitForSelector(`.message-system:has-text("${bea.name} removed the group's picture.")`, { timeout: 20000 });
  await a.waitForSelector('.group-dm-header-picture', { state: 'detached', timeout: 20000 });
  await a.waitForSelector('.dm-group .group-avatar-img', { timeout: 20000 });
  check((await apiPicture(a, groupId)).group.picture_id === null, 'removed: everyone is back to the members\' pictures');
  await shot(a, '07-removed');
} catch (err) {
  console.log('FAIL', err.message);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
