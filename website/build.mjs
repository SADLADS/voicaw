#!/usr/bin/env node
// Builds voicaw.com, the info and download site (the app itself is at app.voicaw.com; see README
// "voicaw.com and app.voicaw.com").
//
//   node website/build.mjs [siteDir]
//
// siteDir: the folder nginx serves (default /opt/voicaw-site, or VOICAW_SITE_DIR). The newest
// desktop version and its installers are written into the page (no script needed to show them),
// from the update site's desktop/releases.json: read from its folder (VOICAW_UPDATES_DIR,
// default /opt/voicaw-updates) when it's on this machine, else fetched from
// https://updates.voicaw.com. updates/publish.mjs runs this after every release, so
// desktop-release/release.sh keeps the page current by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const APP_URL = 'https://app.voicaw.com';
export const UPDATES_URL = 'https://updates.voicaw.com';
const NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
// Windows first: it's what most people download (and what a phone visitor sees offered).
const ORDER = ['windows', 'mac', 'linux'];

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const size = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const fileUrl = (name) => `${UPDATES_URL}/desktop/${encodeURIComponent(name)}`;

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function writeAtomic(to, data) {
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, to);
}

// What's published, as { windows: { version, date, files: [{ name, label, size }] }, ... }.
export async function loadReleases(updatesDir = process.env.VOICAW_UPDATES_DIR || '/opt/voicaw-updates') {
  try {
    return JSON.parse(fs.readFileSync(path.join(updatesDir, 'desktop/releases.json'), 'utf8')).platforms ?? {};
  } catch {
    // Not on this machine: ask the live site.
  }
  try {
    const res = await fetch(`${UPDATES_URL}/desktop/releases.json`, { cache: 'no-store' });
    if (res.ok) return (await res.json()).platforms ?? {};
  } catch {
    // Offline.
  }
  console.warn('No desktop releases found: the page says downloads are coming.');
  return {};
}

// The newest Android APK, as updates/publish-android.mjs records it ({ version, date, file:
// { name, size } }), or null: from the update site's folder when it's on this machine, else
// fetched.
export async function loadAndroidRelease(updatesDir = process.env.VOICAW_UPDATES_DIR || '/opt/voicaw-updates') {
  try {
    return JSON.parse(fs.readFileSync(path.join(updatesDir, 'android/releases.json'), 'utf8')).android ?? null;
  } catch {
    // Not on this machine: ask the live site.
  }
  try {
    const res = await fetch(`${UPDATES_URL}/android/releases.json`, { cache: 'no-store' });
    if (res.ok) return (await res.json()).android ?? null;
  } catch {
    // Offline.
  }
  return null;
}

const androidUrl = (name) => `${UPDATES_URL}/android/${encodeURIComponent(name)}`;

// The Android card under "Phones and tablets" (a download when there's an APK), the steps to
// install it, and the big button phone visitors get first.
export function renderAndroid(android) {
  if (!android?.version || !android.file) {
    return {
      ANDROID_CARD: `<div class="store soon">
        ${ANDROID_ICON}
        <span><strong>Android</strong><small>Coming soon</small></span>
      </div>`,
      ANDROID_NOTE: '',
      ANDROID_PRIMARY: '',
    };
  }
  const url = androidUrl(android.file.name);
  const detail = `Version ${escape(android.version)} · ${size(android.file.size)}`;
  return {
    ANDROID_CARD: `<a class="store" href="${escape(url)}">
        ${ANDROID_ICON}
        <span><strong>Android</strong><small>${detail}</small></span>
      </a>`,
    ANDROID_NOTE: `<p class="note">
      For Android 8 or newer, from this site rather than Google Play (for now). Open the
      downloaded file to install it. Android asks once to allow installing apps from your browser,
      and Play Protect may warn that it doesn't know the app: tap <em>More details</em>, then
      <em>Install anyway</em>. It doesn't update itself yet: get new versions here.
    </p>`,
    ANDROID_PRIMARY: `<template data-primary="android"><a class="button" id="primary-download" data-platform="android" href="${escape(url)}">
      <strong>Download for Android</strong>
      <span>${detail}</span>
    </a></template>`,
  };
}

const ANDROID_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5v17l9-8.5z"/><path d="M5 3.5l11.5 6.6L14 12.5M5 20.5l11.5-6.6L14 11.5M16.5 10.1l3 1.7a.3.3 0 0 1 0 .4l-3 1.7"/></svg>';

function primaryButton(platform, release, attrs = '') {
  const file = release.files[0];
  const detail = [`Version ${release.version}`, file.label, size(file.size)].join(' · ');
  return `<a class="button" ${attrs}href="${escape(fileUrl(file.name))}">
      <strong>Download for ${NAMES[platform]}</strong>
      <span>${escape(detail)}</span>
    </a>`;
}

// The page's download parts, from the releases.
export function renderParts(releases) {
  const available = ORDER.filter((p) => releases[p]?.version && releases[p]?.files?.length);
  if (!available.length) {
    return {
      PRIMARY_DOWNLOAD: '',
      DOWNLOADS: '<p class="note">The desktop app is coming soon. Until then, Voicaw works in any browser.</p>',
      VERSION_LINE: '',
    };
  }
  const first = available[0];
  // The first system is in the page as it is; the others wait in templates, swapped in by the
  // page's script for visitors on them.
  const primary = [
    primaryButton(first, releases[first], `id="primary-download" data-platform="${first}" `),
    ...available.slice(1).map((p) => `<template data-primary="${p}">${primaryButton(p, releases[p], `id="primary-download" data-platform="${p}" `)}</template>`),
  ].join('\n    ');
  const lists = available.map((p) => {
    const release = releases[p];
    const date = formatDate(release.date);
    const items = release.files.map((file) => `<li><a href="${escape(fileUrl(file.name))}"><span>${escape(file.label)}</span><small>${size(file.size)}</small></a></li>`);
    return `<h3>${NAMES[p]} · version ${escape(release.version)}${date ? ` · ${date}` : ''}</h3>
    <ul>
      ${items.join('\n      ')}
    </ul>`;
  });
  const newest = available.map((p) => releases[p].version).sort(compareVersions).at(-1);
  return {
    PRIMARY_DOWNLOAD: primary,
    DOWNLOADS: lists.join('\n    '),
    VERSION_LINE: `Desktop app ${escape(newest)}`,
  };
}

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function renderPage(releases, android = null) {
  const template = fs.readFileSync(path.join(here, 'src/index.html'), 'utf8');
  const style = fs.readFileSync(path.join(here, 'src/style.css'));
  const parts = renderParts(releases);
  if (android?.version) {
    parts.VERSION_LINE = [parts.VERSION_LINE, `Android app ${escape(android.version)}`].filter(Boolean).join(' · ');
  }
  const values = {
    ...parts,
    ...renderAndroid(android),
    APP_URL,
    UPDATES_URL,
    // Changes with the stylesheet, so a cached old one is never used with a new page.
    STYLE_VERSION: crypto.createHash('sha256').update(style).digest('hex').slice(0, 10),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`website/src/index.html: unknown placeholder ${match}`);
    return values[key];
  });
}

export async function buildSite({ siteDir = process.env.VOICAW_SITE_DIR || '/opt/voicaw-site', releases, android } = {}) {
  siteDir = path.resolve(siteDir);
  if (!fs.existsSync(siteDir)) {
    throw new Error(`${siteDir} doesn't exist (README "voicaw.com and app.voicaw.com" sets it up).`);
  }
  releases ??= await loadReleases();
  if (android === undefined) android = await loadAndroidRelease();
  const html = renderPage(releases, android);
  // Everything but the page first, so the page never names a stylesheet that isn't there.
  for (const name of fs.readdirSync(path.join(here, 'src'))) {
    if (name !== 'index.html') writeAtomic(path.join(siteDir, name), fs.readFileSync(path.join(here, 'src', name)));
  }
  for (const name of ['logo192.png', 'logo512.png', 'favicon.ico', 'apple-touch-icon.png']) {
    writeAtomic(path.join(siteDir, name), fs.readFileSync(path.join(root, 'client/public', name)));
  }
  writeAtomic(path.join(siteDir, 'index.html'), html);
  const versions = ORDER.filter((p) => releases[p]?.version).map((p) => `${NAMES[p]} ${releases[p].version}`);
  if (android?.version) versions.push(`Android ${android.version}`);
  console.log(`Website built in ${siteDir} (${versions.join(', ') || 'no releases yet'}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite({ siteDir: process.argv[2] || undefined }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
