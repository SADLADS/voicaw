// `npm run build`'s second half: puts the web build (vite's output in build-web/) live at
// /opt/voicaw-client (or VOICAW_WEB_ROOT). Only runs once vite has built everything, so a
// failed build leaves the live app as it was. On the way it reports what devices precache
// (the service worker downloads all of it on every update) and warns over PRECACHE_BUDGET.
//
// rsync swaps the files in together at the end (--delay-updates) and only then removes the
// old build's (--delete-after). Pages still on the old build lose its lazily loaded files then,
// as before, and are offered a reload (`vite:preloadError`, see PWA updates in docs/client.md).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const PRECACHE_BUDGET = 6 * 1000 * 1000;
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build-web');
const target = process.env.VOICAW_WEB_ROOT || '/opt/voicaw-client';

const fail = (message) => {
  console.error(`publish-web: ${message}; ${target} was not changed.`);
  process.exit(1);
};

for (const file of ['index.html', 'service-worker.js', 'manifest.json']) {
  if (!fs.existsSync(path.join(source, file))) fail(`${file} is missing from ${source}`);
}

const sw = fs.readFileSync(path.join(source, 'service-worker.js'), 'utf8');
const urls = [...new Set([...sw.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]))];
if (urls.length === 0) fail('the service worker has no precache list');
const files = urls.map((url) => {
  const file = path.join(source, url);
  if (!fs.existsSync(file)) fail(`the service worker precaches ${url}, which isn't in the build`);
  return { url, size: fs.statSync(file).size };
}).sort((a, b) => b.size - a.size);
// What the page loads at startup must be precached, or the installed app can't start offline
// (what a file over Workbox's size limit leads to).
const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
for (const [, url] of html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)) {
  if (!urls.includes(url)) fail(`index.html loads ${url}, which the service worker doesn't precache`);
}
const total = files.reduce((sum, f) => sum + f.size, 0);
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
console.log(`Precache: ${files.length} files, ${mb(total)} (budget ${mb(PRECACHE_BUDGET)}). Largest:`);
for (const f of files.slice(0, 5)) console.log(`  ${mb(f.size).padStart(8)}  ${f.url}`);
if (total > PRECACHE_BUDGET) {
  console.warn(`publish-web: warning: the precache is over its budget; every device downloads it on each update.`);
}

if (!fs.existsSync(target)) fail(`${target} doesn't exist`);
execFileSync('rsync', ['-rlt', '--delay-updates', '--delete-after', `${source}/`, `${target}/`], { stdio: 'inherit' });
console.log(`Published to ${target}.`);
