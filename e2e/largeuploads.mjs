// Big files (up to Settings → Admin's File size limit, 500 MB by default): a 120 MB file sent
// in a DM goes up in parts, encrypted a part at a time (the page's memory stays far below the
// file's size), and the other person saves it through the service worker, decrypted as it
// downloads (likewise), as does the desktop app (stand-in bridge) into its Save dialog's file;
// then a 501 MB file is refused, and the admin's 100 MB limit applies.
//   node e2e/serve.mjs &   then   node e2e/largeuploads.mjs [screenshot dir]
// LARGE_MB sets the big file's size (default 120). The files are sparse (no disk or memory).
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, signUp, openChat, send } from './helpers.mjs';

const dir = process.argv[2];
if (dir) mkdirSync(dir, { recursive: true });
const shot = (page, name) => dir && page.screenshot({ path: `${dir}/${name}.png` });
const MB = 1024 * 1024;
const bigMb = Number(process.env.LARGE_MB || 120);

const tmp = mkdtempSync(join(tmpdir(), 'voicaw-large-'));
const sparse = (name, bytes) => {
  const path = join(tmp, name);
  writeFileSync(path, '');
  truncateSync(path, bytes);
  return path;
};
const bigFile = sparse('archive.zip', bigMb * MB);
const tooBig = sparse('huge.zip', 501 * MB);
const sha256 = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const controlled = (page) => page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
const row = (text) => `.each-dm-message-wrapper:has-text("${text}")`;
const attach = async (page, path) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.attach-button').then(() => page.click('text=Upload a file')),
  ]);
  await chooser.setFiles(path);
};

// The most the page's JavaScript holds (its heap and ArrayBuffers' memory), sampled until
// `stop()`; resolves to the peak in MB. Garbage is collected before each sample: what counts is
// what the page keeps, not what headless Chrome (no memory pressure) hasn't got round to freeing.
async function watchMemory(page) {
  const cdp = await page.context().newCDPSession(page);
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      await cdp.send('HeapProfiler.collectGarbage');
      const { usedSize, backingStorageSize = 0 } = await cdp.send('Runtime.getHeapUsage');
      peak = Math.max(peak, usedSize + backingStorageSize);
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  return async () => {
    running = false;
    await loop;
    return Math.round(peak / MB);
  };
}

// The page's memory before something starts (the peak over a second).
async function settledMemory(page) {
  const stop = await watchMemory(page);
  await new Promise((r) => setTimeout(r, 1000));
  return stop();
}

async function setLimit(page, value) {
  await page.evaluate(async (v) => {
    const res = await fetch('/api/admin/settings/uploadLimit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ value: v }),
    });
    if (!res.ok) throw new Error(`uploadLimit: ${res.status}`);
  }, value);
}

const browser = await launchChrome();
try {
  const alice = await signUp(browser, 'alice');
  const bob = await signUp(browser, 'bob');
  const admin = await signUp(browser, 'admin');
  for (const user of [alice, bob]) {
    await user.page.reload();
    await controlled(user.page);
  }
  await openChat(alice.page, bob.id);
  await openChat(bob.page, alice.id);

  // Alice sends the big file: in parts, never all in her page's memory.
  const parts = [];
  const singles = [];
  alice.page.on('request', (r) => {
    if (r.method() !== 'PUT') return;
    if (r.url().includes('/__part/')) parts.push(r.url());
    else singles.push(r.url());
  });
  await attach(alice.page, bigFile);
  await alice.page.waitForSelector('.attachment-tray, [class*="attachment-chip"], .composer-attachments', { timeout: 10000 }).catch(() => {});
  const baseline = await settledMemory(alice.page);
  const stopAlice = await watchMemory(alice.page);
  const started = Date.now();
  await send(alice.page, 'the archive');
  await bob.page.waitForSelector(`${row('the archive')} .attachment-file`, { timeout: Math.max(180000, bigMb * 2000) });
  const sendPeak = await stopAlice();
  console.log(`sent ${bigMb} MB in ${parts.length} parts (+${singles.length} single PUTs) in ${((Date.now() - started) / 1000).toFixed(1)} s; page memory peak ${sendPeak} MB (${baseline} MB before)`);
  if (parts.length < Math.floor(bigMb / 8)) throw new Error(`expected parts, got ${parts.length}`);
  // The parts in flight (about 75 MB), whatever the file's size; sending it whole took twice
  // the file.
  if (sendPeak - baseline > 200) throw new Error(`sending held ${sendPeak - baseline} MB`);
  const label = await bob.page.textContent(`${row('the archive')} .attachment-file`);
  if (!label.includes('archive.zip') || !label.includes(`${bigMb} MB`)) throw new Error(`file box: ${label}`);
  await shot(bob.page, '1-file-box');

  // Bob saves it: the browser's own download, decrypted by the worker as it arrives.
  const bobBaseline = await settledMemory(bob.page);
  const stopBob = await watchMemory(bob.page);
  const [download] = await Promise.all([
    bob.page.waitForEvent('download', { timeout: 60000 }),
    bob.page.click(`${row('the archive')} .attachment-file-download`),
  ]);
  if (download.suggestedFilename() !== 'archive.zip') throw new Error(`saved as ${download.suggestedFilename()}`);
  const savedPath = await download.path();
  const savePeak = await stopBob();
  const savedSize = statSync(savedPath).size;
  console.log(`saved ${Math.round(savedSize / MB)} MB through the worker; page memory peak ${savePeak} MB (${bobBaseline} MB before)`);
  if (savedSize !== bigMb * MB || await sha256(savedPath) !== await sha256(bigFile)) throw new Error('saved file differs');
  if (savePeak - bobBaseline > 200) throw new Error(`saving held ${savePeak - bobBaseline} MB`);

  // The desktop app (stand-in bridge, no service worker): the Save dialog's file gets the
  // pieces as they're decrypted (all zeros here, the file being sparse), never the whole file.
  const desktopContext = await browser.newContext({ viewport: { width: 1100, height: 750 }, serviceWorkers: 'block' });
  await desktopContext.addInitScript(() => {
    const saved = { started: [], bytes: 0, nonZero: 0, appends: 0, finished: false, cancelled: false };
    window.__saved = saved;
    window.voicawDesktop = {
      platform: 'linux',
      getInfo: async () => ({ version: '0.1.0', packaged: false }),
      notify: () => {},
      setUnread: () => {},
      getSettings: async () => ({ closeToTray: true, startAtLogin: false, shortcuts: {} }),
      updateSettings: async (s) => ({ settings: s, failedShortcuts: [] }),
      checkForUpdates: async () => 'unsupported',
      onNavigate: () => () => {},
      onShortcut: () => () => {},
      onUpdateReady: () => () => {},
      onUpdateProgress: () => () => {},
      saveFile: {
        start: async (name) => { saved.started.push(name); return 1; },
        append: async (id, bytes) => {
          saved.appends += 1;
          saved.bytes += bytes.length;
          for (let i = 0; i < bytes.length; i += 4096) if (bytes[i]) saved.nonZero += 1;
        },
        finish: async () => { saved.finished = true; },
        cancel: async () => { saved.cancelled = true; },
      },
    };
  });
  const bobDesktop = await desktopContext.newPage();
  await bobDesktop.goto(new URL('/', bob.page.url()).href);
  await bobDesktop.fill('input[placeholder="Username"]', bob.name);
  await bobDesktop.fill('input[placeholder="Password"]', bob.password);
  await bobDesktop.press('input[placeholder="Password"]', 'Enter');
  await bobDesktop.waitForSelector('#dm-main', { timeout: 20000 });
  await openChat(bobDesktop, alice.id);
  await bobDesktop.waitForSelector(`${row('the archive')} .attachment-file`, { timeout: 20000 });
  const desktopBaseline = await settledMemory(bobDesktop);
  const stopDesktop = await watchMemory(bobDesktop);
  await bobDesktop.click(`${row('the archive')} .attachment-file-download`);
  await bobDesktop.waitForSelector(`${row('the archive')} .attachment-file-size:has-text("Downloading")`, { timeout: 20000 });
  await shot(bobDesktop, '2-desktop-downloading');
  await bobDesktop.waitForFunction(() => window.__saved.finished || window.__saved.cancelled, null, { timeout: 180000 });
  const desktopPeak = await stopDesktop();
  const desktopSaved = await bobDesktop.evaluate(() => window.__saved);
  console.log(`desktop app saved ${Math.round(desktopSaved.bytes / MB)} MB in ${desktopSaved.appends} pieces; page memory peak ${desktopPeak} MB (${desktopBaseline} MB before)`);
  if (!desktopSaved.finished || desktopSaved.bytes !== bigMb * MB || desktopSaved.nonZero) throw new Error(`desktop save: ${JSON.stringify(desktopSaved)}`);
  if (desktopSaved.started.join() !== 'archive.zip') throw new Error(`desktop save named ${desktopSaved.started}`);
  if (desktopPeak - desktopBaseline > 200) throw new Error(`desktop saving held ${desktopPeak - desktopBaseline} MB`);
  // Afterwards the box is back to the file's size (it isn't kept decrypted).
  await bobDesktop.waitForSelector(`${row('the archive')} .attachment-file-size:has-text("${bigMb} MB")`, { timeout: 5000 });
  await desktopContext.close();

  // Over the limit (500 MB): refused before anything is sent.
  await attach(alice.page, tooBig);
  const refused = await alice.page.waitForSelector('[role="alert"]', { timeout: 5000 });
  const refusal = await refused.textContent();
  if (!refusal.includes('huge.zip') || !refusal.includes('500 MB')) throw new Error(`refusal: ${refusal}`);
  await shot(alice.page, '3-too-big');

  // The admin lowers it to 100 MB: the big file is refused too, from the next start.
  await setLimit(admin.page, '100');
  await alice.page.reload();
  await openChat(alice.page, bob.id);
  await attach(alice.page, bigFile);
  const lowered = await (await alice.page.waitForSelector('[role="alert"]', { timeout: 5000 })).textContent();
  if (!lowered.includes('100 MB')) throw new Error(`with 100 MB: ${lowered}`);
  await setLimit(admin.page, null);

  console.log('largeuploads: ok');
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
