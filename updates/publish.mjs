#!/usr/bin/env node
// Publishes desktop app builds to the update site (updates.voicaw.com, see README "Desktop app").
//
//   node updates/publish.mjs [buildDir] [siteDir]
//
// buildDir: electron-builder's output (default dist-desktop). siteDir: the folder nginx serves
// (default /opt/voicaw-updates, or VOICAW_UPDATES_DIR). Builds for each system can come from
// different machines: run this once per folder of installers; each run only replaces what it
// brings (a Linux build leaves the Windows one in place).
//
// The site gets the download page (updates/site), the logo, and in desktop/: the installers and
// blockmaps, then releases.json (what the page lists), then the latest*.yml files last, each
// written to a hidden temporary file and renamed, so an installed app never sees a feed naming
// a file that isn't there yet. Older installers stay (people may be mid-download).
//
// Then it rebuilds voicaw.com (website/build.mjs) with the new version and installers, unless
// this run went to some other folder than the real update site (a try-out) and VOICAW_SITE_DIR
// doesn't say where its website goes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../website/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const buildDir = path.resolve(process.argv[2] || path.join(root, 'dist-desktop'));
const DEFAULT_SITE_DIR = '/opt/voicaw-updates';
const siteDir = path.resolve(process.argv[3] || process.env.VOICAW_UPDATES_DIR || DEFAULT_SITE_DIR);
const desktopDir = path.join(siteDir, 'desktop');

// Which system an installer is for, and how the page describes it. Update-only files (macOS's
// zip, blockmaps) are published but not listed.
const KINDS = [
    { test: /\.exe$/i, platform: 'windows', label: 'Windows installer' },
    { test: /\.dmg$/i, platform: 'mac', label: 'macOS disk image' },
    { test: /\.AppImage$/, platform: 'linux', label: 'AppImage (any distribution)' },
    { test: /\.deb$/i, platform: 'linux', label: '.deb (Debian, Ubuntu)' },
];
const PUBLISHED = /\.(exe|dmg|zip|AppImage|deb|blockmap)$/i;
const FEED = /^latest(-[a-z0-9]+)?\.yml$/;

function copyAtomic(from, to) {
    const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp`);
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to);
}

function writeAtomic(to, text) {
    const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, to);
}

function versionOf(feedText) {
    return /^version:\s*['"]?([^'"\s]+)/m.exec(feedText)?.[1] ?? null;
}

if (!fs.existsSync(buildDir)) {
    console.error(`No build folder at ${buildDir}: run npm run dist:electron first.`);
    process.exit(1);
}
const names = fs.readdirSync(buildDir).filter((n) => fs.statSync(path.join(buildDir, n)).isFile());
const feeds = names.filter((n) => FEED.test(n));
const files = names.filter((n) => PUBLISHED.test(n));
if (!feeds.length || !files.length) {
    console.error(`Nothing to publish in ${buildDir} (no installers or latest*.yml).`);
    process.exit(1);
}
// Every installer named in a feed must be here, or the feed would point at nothing.
for (const feed of feeds) {
    const text = fs.readFileSync(path.join(buildDir, feed), 'utf8');
    for (const [, name] of text.matchAll(/^\s*(?:-\s*url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) {
        if (!names.includes(name)) {
            console.error(`${feed} names ${name}, which isn't in ${buildDir}.`);
            process.exit(1);
        }
    }
}

fs.mkdirSync(desktopDir, { recursive: true });

// The page and its logo.
for (const name of fs.readdirSync(path.join(here, 'site'))) {
    copyAtomic(path.join(here, 'site', name), path.join(siteDir, name));
}
copyAtomic(path.join(root, 'client/public/logo192.png'), path.join(siteDir, 'logo.png'));
copyAtomic(path.join(root, 'client/public/favicon.ico'), path.join(siteDir, 'favicon.ico'));

// 1. Installers and blockmaps.
for (const name of files) {
    copyAtomic(path.join(buildDir, name), path.join(desktopDir, name));
    console.log(`  ${name}`);
}

// 2. releases.json: per system, its version and installers (kept from earlier runs for the
// systems this one didn't build).
const releasesPath = path.join(desktopDir, 'releases.json');
let releases = {};
try {
    releases = JSON.parse(fs.readFileSync(releasesPath, 'utf8')).platforms ?? {};
} catch {
    // First publish.
}
const feedVersion = {
    windows: 'latest.yml',
    mac: 'latest-mac.yml',
    linux: 'latest-linux.yml',
};
for (const platform of ['windows', 'mac', 'linux']) {
    const ours = files.flatMap((name) => {
        const kind = KINDS.find((k) => k.test.test(name));
        if (!kind || kind.platform !== platform) return [];
        const { size } = fs.statSync(path.join(buildDir, name));
        return [{ name, label: kind.label, size }];
    });
    if (!ours.length) continue;
    const feed = feeds.includes(feedVersion[platform])
        ? fs.readFileSync(path.join(buildDir, feedVersion[platform]), 'utf8')
        : '';
    releases[platform] = {
        version: versionOf(feed),
        date: new Date().toISOString(),
        files: ours,
    };
}
writeAtomic(releasesPath, `${JSON.stringify({ platforms: releases }, null, 2)}\n`);

// 3. The feeds, last.
for (const name of feeds) {
    copyAtomic(path.join(buildDir, name), path.join(desktopDir, name));
    console.log(`  ${name}`);
}
console.log(`Published to ${siteDir}.`);

// 4. voicaw.com's version and download links. The release is out either way; a failure here
// only means the page shows the previous one until `npm run build:site`.
// Going by the folder, not by whether one was named: a release always names it.
const tryOut = siteDir !== path.resolve(DEFAULT_SITE_DIR) && !process.env.VOICAW_SITE_DIR;
if (tryOut) {
    console.log('Not the real update site: voicaw.com left alone (set VOICAW_SITE_DIR to build one).');
} else {
    try {
        await buildSite({ releases });
    } catch (err) {
        console.warn(`voicaw.com wasn't rebuilt: ${err.message}`);
    }
}
