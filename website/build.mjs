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
// The Android app: Google Play's closed test (2026-10-06), which people ask to join on the page
// (its #android-test form, server/routes/testerRequests.js). Play shows it only to testers.
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.voicaw.app';
export const PLAY_TEST_URL = 'https://play.google.com/apps/testing/com.voicaw.app';
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

// What every page can use: the addresses, and the stylesheet's version (it changes with the
// stylesheet, so a cached old one is never used with a new page).
function pageValues() {
  const style = fs.readFileSync(path.join(here, 'src/style.css'));
  return { APP_URL, UPDATES_URL, PLAY_URL, PLAY_TEST_URL, STYLE_VERSION: crypto.createHash('sha256').update(style).digest('hex').slice(0, 10) };
}

export function renderPage(releases) {
  const template = fs.readFileSync(path.join(here, 'src/index.html'), 'utf8');
  const values = {
    ...renderParts(releases),
    ...pageValues(),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`website/src/index.html: unknown placeholder ${match}`);
    return values[key];
  });
}

// ---- The bot API docs (voicaw.com/developers/docs/) ----
// Each page is a fragment in src/developers/ (plain HTML, its sections <h2 id="…">), put in
// src/developers/template.html with the side menu and the page's contents, and written as
// developers/docs/<slug>/index.html (nginx serves <path>/index.html; website/nginx/voicaw.com).
export const DOCS = [
  { slug: '', file: 'overview.html', title: 'Overview', description: "Voicaw's bot API is Discord's: what works and what's different." },
  { slug: 'getting-started', file: 'getting-started.html', title: 'Getting started', description: 'Make an application, get its token and add the bot to a guild.' },
  { slug: 'libraries', file: 'libraries.html', title: 'discord.js, discord.py and HTTP', description: 'Point Discord libraries at Voicaw.' },
  { slug: 'authentication', file: 'authentication.html', title: 'Tokens, rate limits and errors', description: 'Bot tokens, rate limits and error codes.' },
  { slug: 'gateway', file: 'gateway.html', title: 'Gateway', description: 'Connecting to the gateway: opcodes, intents, events and close codes.' },
  { slug: 'voice', file: 'voice.html', title: 'Voice', description: 'Joining voice channels with LiveKit: speaking and listening.' },
  { slug: 'login', file: 'login.html', title: 'Login with Voicaw', description: 'Let people log in to your website with their Voicaw account (OAuth2).' },
  { slug: 'interactions', file: 'interactions.html', title: 'Commands and components', description: 'Slash and context-menu commands, buttons, selects, forms and interactions.' },
  { slug: 'rest', file: 'rest.html', title: 'REST reference', description: 'Every endpoint of the bot API.' },
  { slug: 'objects', file: 'objects.html', title: 'Objects and IDs', description: "How Voicaw's guilds, channels, roles and messages look in the API." },
  { slug: 'permissions', file: 'permissions.html', title: 'Permissions', description: "Discord's permission bits and what they mean on Voicaw." },
  { slug: 'differences', file: 'differences.html', title: 'Differences from Discord', description: "What isn't supported (yet), and what works differently." },
];

const docsPath = (slug) => `/developers/docs/${slug ? `${slug}/` : ''}`;

// The pages, as [{ file: 'developers/docs/<slug>/index.html', html }].
export function renderDocs(values) {
  const dir = path.join(here, 'src/developers');
  const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  const fill = (text, extra, where) => text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    const all = { ...values, ...extra };
    if (!(key in all)) throw new Error(`${where}: unknown placeholder ${match}`);
    return all[key];
  });
  return DOCS.map((page, i) => {
    const content = fill(fs.readFileSync(path.join(dir, page.file), 'utf8'), {}, `website/src/developers/${page.file}`);
    const sections = [...content.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)];
    const nav = DOCS.map((p) => `<a href="${docsPath(p.slug)}"${p === page ? ' aria-current="page"' : ''}>${escape(p.title)}</a>`).join('\n      ');
    const toc = sections.length > 1
      ? `<nav class="docs-toc" aria-label="On this page"><strong>On this page</strong>${sections.map(([, id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav>`
      : '';
    const prev = DOCS[i - 1];
    const next = DOCS[i + 1];
    const pager = [
      prev ? `<a class="prev" href="${docsPath(prev.slug)}"><small>Previous</small>${escape(prev.title)}</a>` : '<span></span>',
      next ? `<a class="next" href="${docsPath(next.slug)}"><small>Next</small>${escape(next.title)}</a>` : '<span></span>',
    ].join('');
    const html = fill(template, {
      TITLE: escape(page.title),
      DESCRIPTION: escape(page.description),
      NAV: nav,
      TOC: toc,
      CONTENT: content,
      PAGER: pager,
    }, 'website/src/developers/template.html');
    return { file: path.join('developers/docs', page.slug, 'index.html'), html };
  });
}

// ---- Policies (voicaw.com/privacy/, /terms/, /delete-account/) ----
// What Google Play (and anyone) needs to read: each a fragment in src/legal/ put in
// src/legal/template.html, written as <slug>/index.html. `updated` is when its wording last
// changed in substance: change it with the text.
export const LEGAL = [
  { slug: 'privacy', file: 'privacy.html', title: 'Privacy policy', updated: '2026-10-26', description: 'What Voicaw stores, what is end-to-end encrypted, and who else sees anything.' },
  { slug: 'terms', file: 'terms.html', title: 'Terms of use', updated: '2026-10-05', description: "Voicaw's rules: what you may not post or do, and what happens if you do." },
  { slug: 'delete-account', file: 'delete-account.html', title: 'Deleting your account', updated: '2026-10-13', description: 'How to delete your Voicaw account and what that removes.' },
];


// Who runs Voicaw and how to reach them, as the policies say it. Unset, a page shows
// "[… not set]" and the build warns, so it can't go out unnoticed without them.
export const LEGAL_FACTS = {
  OPERATOR: 'The Voicaw Team',
  CONTACT_EMAIL: 'voicaw@proton.me',
  GOVERNING_LAW: 'Jersey',
  MINIMUM_AGE: '13',
};

function legalFacts() {
  const facts = {};
  for (const [key, value] of Object.entries(LEGAL_FACTS)) {
    facts[key] = value ? escape(value) : `<mark>[${key.toLowerCase().replace(/_/g, ' ')} not set]</mark>`;
  }
  facts.CONTACT = LEGAL_FACTS.CONTACT_EMAIL
    ? `<a href="mailto:${escape(LEGAL_FACTS.CONTACT_EMAIL)}">${escape(LEGAL_FACTS.CONTACT_EMAIL)}</a>`
    : facts.CONTACT_EMAIL;
  return facts;
}

// The pages, as [{ file: '<slug>/index.html', html }].
export function renderLegal(values) {
  const missing = Object.entries(LEGAL_FACTS).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`Policies: ${missing.join(', ')} not set (website/build.mjs LEGAL_FACTS).`);
  values = { ...values, ...legalFacts() };
  const dir = path.join(here, 'src/legal');
  const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  const fill = (text, extra, where) => text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    const all = { ...values, ...extra };
    if (!(key in all)) throw new Error(`${where}: unknown placeholder ${match}`);
    return all[key];
  });
  return LEGAL.map((page) => {
    const nav = LEGAL.map((p) => `<a href="/${p.slug}/"${p === page ? ' aria-current="page"' : ''}>${escape(p.title)}</a>`).join('\n    ');
    const content = fill(fs.readFileSync(path.join(dir, page.file), 'utf8'), {}, `website/src/legal/${page.file}`);
    const html = fill(template, {
      TITLE: escape(page.title),
      DESCRIPTION: escape(page.description),
      UPDATED: formatDate(`${page.updated}T00:00:00Z`),
      NAV: nav,
      CONTENT: content,
    }, 'website/src/legal/template.html');
    return { file: path.join(page.slug, 'index.html'), html };
  });
}

export async function buildSite({ siteDir = process.env.VOICAW_SITE_DIR || '/opt/voicaw-site', releases } = {}) {
  siteDir = path.resolve(siteDir);
  if (!fs.existsSync(siteDir)) {
    throw new Error(`${siteDir} doesn't exist (README "voicaw.com and app.voicaw.com" sets it up).`);
  }
  releases ??= await loadReleases();
  const html = renderPage(releases);
  // Everything but the pages first, so a page never names a stylesheet that isn't there.
  // (Folders, like the docs' sources in src/developers, aren't copied.)
  for (const entry of fs.readdirSync(path.join(here, 'src'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== 'index.html') {
      writeAtomic(path.join(siteDir, entry.name), fs.readFileSync(path.join(here, 'src', entry.name)));
    }
  }
  for (const name of ['logo192.png', 'logo512.png', 'favicon.ico', 'apple-touch-icon.png']) {
    writeAtomic(path.join(siteDir, name), fs.readFileSync(path.join(root, 'client/public', name)));
  }
  for (const page of [...renderDocs(pageValues()), ...renderLegal(pageValues())]) {
    const to = path.join(siteDir, page.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    writeAtomic(to, page.html);
  }
  writeAtomic(path.join(siteDir, 'index.html'), html);
  const versions = ORDER.filter((p) => releases[p]?.version).map((p) => `${NAMES[p]} ${releases[p].version}`);
  console.log(`Website built in ${siteDir} (${versions.join(', ') || 'no releases yet'}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite({ siteDir: process.argv[2] || undefined }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
