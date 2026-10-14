// The offline copy (Offline copy, docs/messages.md): Bea reads a DM, a group DM and her notes
// online; the copy is only ciphertext. With the API out of reach (refused, then 502) a reload
// opens in offline mode: the banner, the DM list, all three chats read-only (composer locked,
// no hover tools), an unsaved chat says so, Settings → Storage shows the copy. The API back:
// "reachable again", Reconnect = online. A message deleted while online drops out of the copy.
// Storage's switch off deletes it; logging out deletes every database. A phone's banner fits.
//   node e2e/serve.mjs &   then   node e2e/offline.mjs [screenshot dir]
import { launchChrome, signUp, devices, BASE, makeFriends, send } from './helpers.mjs';

const shots = process.argv[2];
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`ok: ${what}`);
};

// Everything in the offline copy's message store, as the bytes on disk.
const storedBytes = (page) => page.evaluate(async () => {
  // Opening a database that isn't there would make it.
  if (!(await indexedDB.databases()).some((d) => d.name === 'voicaw-offline')) return [];
  return new Promise((resolve) => {
  const req = indexedDB.open('voicaw-offline');
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('messages')) { db.close(); resolve([]); return; }
    db.transaction('messages').objectStore('messages').getAll().onsuccess = (e) => {
      db.close();
      resolve(e.target.result.map((r) => new TextDecoder().decode(r.data)));
    };
  };
  });
});
const waitForSaved = async (page, count) => {
  for (let i = 0; i < 40; i++) {
    if ((await storedBytes(page)).length >= count) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`the offline copy never reached ${count} messages (${(await storedBytes(page)).length})`);
};

const api = (page, method, path) => page.evaluate(async ([m, p]) => {
  const res = await fetch(`/api${p}`, { method: m, headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  return res.headers.get('content-type')?.includes('json') ? res.json() : null;
}, [method, path]);

const goOffline = (page, mode = 'abort') => page.route('**/api/**', (route) => (
  mode === 'abort' ? route.abort('connectionrefused') : route.fulfill({ status: 502, body: 'Bad Gateway' })
));

const browser = await launchChrome();
try {
  const ann = await signUp(browser, 'ann');
  const bea = await signUp(browser, 'bea');
  const cal = await signUp(browser, 'cal');
  await makeFriends(ann, bea, cal);
  const [a, b] = [ann.page, bea.page];
  b.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|ERR_CONNECTION_REFUSED|Network Error|502/i.test(m.text())) console.log('[bea error]', m.text().slice(0, 200));
  });

  // Ann writes to Bea, and makes a group with her.
  await a.goto(`${BASE}/dm/${bea.id}`);
  await a.waitForSelector('#dm-input[contenteditable="true"]');
  await send(a, 'dm one');
  await send(a, 'dm two');
  await a.waitForSelector('.dm-message:not(.pending) >> text=dm two');
  await a.goto(`${BASE}/dm`);
  await a.click('button[aria-label="New group"]');
  await a.fill('input[aria-label="Group name"]', 'Trip');
  await a.check(`.user-picker-row:has-text("${bea.name}") input`);
  await a.check(`.user-picker-row:has-text("${cal.name}") input`);
  await a.click('button:has-text("Create Group")');
  await a.waitForURL('**/dm/g/**');
  await a.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  await send(a, 'hello group');
  await a.waitForSelector('.dm-message:not(.pending) >> text=hello group');
  const groupPath = new URL(a.url()).pathname;

  // Bea reads all three online (her notes she writes herself).
  await b.goto(`${BASE}/dm/${ann.id}`);
  await b.waitForSelector('.dm-message >> text=dm two');
  await b.waitForTimeout(500); // a page load right after opening a chat
  await b.goto(`${BASE}${groupPath}`);
  await b.waitForSelector('.dm-message >> text=hello group');
  await b.waitForTimeout(500); // a page load right after opening a chat
  await b.goto(`${BASE}/dm/notes`);
  await b.waitForSelector('#dm-input[contenteditable="true"]');
  await send(b, 'my note');
  await b.waitForSelector('.dm-message:not(.pending) >> text=my note');
  await waitForSaved(b, 4);
  const bytes = await storedBytes(b);
  check(!bytes.some((s) => /dm one|dm two|hello group|my note/.test(s)), 'the copy on disk is ciphertext only');

  // Out of reach: a reload opens offline.
  await goOffline(b);
  await b.goto(`${BASE}/dm/${ann.id}`);
  await b.waitForSelector('.offline-banner', { timeout: 20000 });
  check(true, 'offline banner after a reload with the API refusing');
  await b.waitForSelector('.dm-message >> text=dm one');
  await b.waitForSelector('.dm-message >> text=dm two');
  check(await b.isVisible(`.dm-user:has-text("${ann.name}")`), 'the DM list comes from the copy');
  const locked = await b.textContent('.composer-locked');
  check(/offline/i.test(locked) && !(await b.$('#dm-input')), `composer locked: "${locked.trim()}"`);
  await b.hover('.dm-message >> text=dm two');
  check(!(await b.$('.message-menu')), 'no hover tools offline');
  await shot(b, '01-offline-dm');
  // The right-click menu keeps Copy only of what needs no server.
  await b.click('.dm-message >> text=dm two', { button: 'right' });
  const menu = await b.textContent('.vc-menu, .message-context-menu, [role="menu"]').catch(() => '');
  check(!/Reply|Edit|Delete|Pin/.test(menu ?? ''), `menu has no Reply/Edit/Delete/Pin: "${(menu ?? '').trim().slice(0, 80)}"`);
  await b.keyboard.press('Escape');

  await b.goto(`${BASE}${groupPath}`);
  await b.waitForSelector('.dm-message >> text=hello group', { timeout: 15000 }).catch(async (e) => {
    await shot(b, 'debug-group');
    console.log('group page:', (await b.textContent('.main-content-wrapper')).slice(0, 300));
    throw e;
  });
  await b.waitForSelector('.message-system:has-text("added you")');
  check(true, 'group DM offline, with its membership rows');
  await shot(b, '02-offline-group');
  await b.goto(`${BASE}/dm/notes`);
  await b.waitForSelector('.dm-message >> text=my note');
  check(true, 'notes offline');
  await b.goto(`${BASE}/dm/${cal.id}`);
  await b.waitForSelector('text=isn\'t saved on this device', { timeout: 15000 });
  check(true, 'an unsaved chat says it isn\'t saved');
  await b.goto(`${BASE}/settings/privacy#storage`);
  await b.waitForSelector('.storage-row >> text=messages', { timeout: 15000 });
  const sizeLine = await b.textContent('.storage-row');
  check(/4 messages/.test(sizeLine), `Storage: "${sizeLine.trim()}"`);
  await b.locator('.storage-row').first().scrollIntoViewIfNeeded();
  await shot(b, '03-offline-storage');

  // The API proxy answering 502 (an API restart) counts as out of reach too.
  await b.unroute('**/api/**');
  await goOffline(b, '502');
  await b.goto(`${BASE}/dm/${ann.id}`);
  await b.waitForSelector('.dm-message >> text=dm two', { timeout: 20000 });
  check(await b.isVisible('.offline-banner'), 'offline with 502s');

  // Back: the banner says so, Reconnect goes online.
  await b.unroute('**/api/**');
  await b.waitForSelector('.offline-banner >> text=reachable again', { timeout: 15000 });
  await shot(b, '04-reachable');
  await b.click('.offline-banner button:has-text("Reconnect")');
  await b.waitForSelector('#dm-input[contenteditable="true"]', { timeout: 20000 });
  check(!(await b.$('.offline-banner')), 'Reconnect: online again, composer back');

  // Ann deletes "dm one"; Bea's open chat drops it, and so does the copy.
  const rows = await api(a, 'GET', `/dm-messages/${bea.id}`);
  const one = rows.find((r) => r.sender_id === ann.id && r.id === Math.min(...rows.map((x) => x.id)));
  await api(a, 'DELETE', `/messages/${one.id}`);
  await b.waitForSelector('.dm-message >> text=dm one', { state: 'detached', timeout: 10000 });
  await b.waitForTimeout(2500);
  await goOffline(b);
  await b.reload();
  await b.waitForSelector('.dm-message >> text=dm two', { timeout: 20000 });
  check(!(await b.$('.dm-message >> text=dm one')), 'a deleted message left the copy');
  await b.unroute('**/api/**');

  // Storage's switch off deletes the copy.
  await b.goto(`${BASE}/settings/privacy#storage`);
  await b.waitForSelector('.storage-row >> text=messages');
  await b.uncheck('label:has-text("Keep an offline copy") input');
  await b.waitForFunction(() => /0 messages/.test(document.querySelector('.storage-row')?.textContent ?? ''));
  check((await storedBytes(b)).length === 0, 'switch off: the copy is gone');
  await b.check('label:has-text("Keep an offline copy") input');

  // Logging out deletes every database the account had.
  await b.goto(`${BASE}/dm/${ann.id}`);
  await b.waitForSelector('.dm-message >> text=dm two');
  await waitForSaved(b, 1);
  await b.goto(`${BASE}/settings`);
  await b.click('.settings-nav-item.danger');
  await b.waitForTimeout(300);
  await b.keyboard.press('Enter');
  await b.waitForSelector('input[placeholder="Username"]', { timeout: 15000 });
  // The copies are deleted; keys and group keys emptied (contact pins and this device's
  // notification settings stay: they're not the account's data).
  const left = await b.evaluate(async () => {
    const records = (name) => new Promise((resolve) => {
      const req = indexedDB.open(name);
      req.onsuccess = async () => {
        const db = req.result;
        let n = 0;
        for (const store of db.objectStoreNames) {
          n += await new Promise((r) => { db.transaction(store).objectStore(store).count().onsuccess = (e) => r(e.target.result); });
        }
        db.close();
        resolve(n);
      };
    });
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    return { dbs, keys: await records('voicaw-keys'), groups: await records('voicaw-groups'), token: localStorage.getItem('token') };
  });
  check(!left.token && !left.dbs.some((n) => /voicaw-(offline|search)/.test(n)) && left.keys === 0 && left.groups === 0,
    `logout left nothing of the account: ${JSON.stringify(left)}`);

  // A phone: the banner fits.
  const dan = await signUp(browser, 'dan', { ...devices['Pixel 7'] });
  const d = dan.page;
  await d.goto(`${BASE}/dm/notes`);
  await d.waitForSelector('#dm-input[contenteditable="true"]');
  await d.tap('#dm-input');
  await d.keyboard.type('phone note');
  await d.tap('button:has-text("Send")');
  await d.waitForSelector('.dm-message:not(.pending) >> text=phone note');
  await waitForSaved(d, 1);
  await goOffline(d);
  await d.reload();
  await d.waitForSelector('.offline-banner', { timeout: 20000 });
  await d.waitForSelector('.dm-message >> text=phone note');
  const fits = await d.evaluate(() => {
    const r = document.querySelector('.offline-banner').getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
  });
  check(fits, 'phone: banner fits, no sideways scroll');
  await shot(d, '05-phone');
  console.log('offline: OK');
} catch (err) {
  console.error('offline: FAILED', err.message.split('\n').slice(0, 4).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
