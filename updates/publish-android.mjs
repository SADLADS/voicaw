#!/usr/bin/env node
// The Android app's releases on the update site (updates.voicaw.com/android/, see README
// "Android app"). build-android.sh uses both commands:
//
//   node updates/publish-android.mjs next <patch|minor|major|X.Y.Z> [siteDir]
//       prints the version this release gets: higher than the one published (or, before the
//       first, mobile/package.json's version), else fails
//   node updates/publish-android.mjs publish <apk> <version> [siteDir]
//       copies the APK in as voicaw-<version>.apk, then releases.json (what installed apps
//       check), then voicaw.apk (always the newest), each written to a hidden temporary file
//       and renamed so nothing ever names a half-copied file; older APKs stay. Then the
//       download page.
//
// The APKs are no longer offered to anyone (2026-10-06: new people get the app from Google
// Play's closed test, which voicaw.com links to): they're published only so the copies already
// installed from here keep updating themselves.
//
// siteDir: the folder nginx serves (default /opt/voicaw-updates, or VOICAW_UPDATES_DIR).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const versionCode = (version) => {
  const [x, y, z] = version.split('.').map(Number);
  return x * 10000 + y * 100 + z;
};

const parse = (version) => (/^\d+\.\d+\.\d+$/.test(version ?? '') ? version.split('.').map(Number) : null);

// The next version after `published` (null before the first release, which starts from
// `initial`): `want` is patch, minor, major or an exact X.Y.Z, which must be higher.
export function nextVersion(want, published, initial = '0.1.0') {
  if (!published) {
    if (parse(want)) return want;
    return initial;
  }
  const [a, b, c] = parse(published);
  let next;
  if (want === 'patch') next = [a, b, c + 1];
  else if (want === 'minor') next = [a, b + 1, 0];
  else if (want === 'major') next = [a + 1, 0, 0];
  else if (parse(want)) next = parse(want);
  else throw new Error(`Not a version: ${want} (patch, minor, major or X.Y.Z)`);
  if (next[1] > 99 || next[2] > 99) throw new Error(`${next.join('.')}: minor and patch must stay under 100 (versionCode)`);
  if (versionCode(next.join('.')) <= versionCode(published)) {
    throw new Error(`${next.join('.')} is not higher than the published ${published}`);
  }
  return next.join('.');
}

const androidDir = (siteDir) => path.join(siteDir, 'android');

export function readRelease(siteDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(androidDir(siteDir), 'releases.json'), 'utf8')).android ?? null;
  } catch {
    return null;
  }
}

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

export async function publish(apk, version, siteDir) {
  if (!parse(version)) throw new Error(`Not a version: ${version}`);
  if (!fs.existsSync(apk)) throw new Error(`No APK at ${apk}`);
  const dir = androidDir(siteDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `voicaw-${version}.apk`;
  const data = fs.readFileSync(apk);

  // 1. The APK, under its version's name (never changes once published, so it's cached).
  copyAtomic(apk, path.join(dir, name));
  // 2. What the pages list.
  const release = {
    version,
    versionCode: versionCode(version),
    date: new Date().toISOString(),
    file: { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') },
  };
  writeAtomic(path.join(dir, 'releases.json'), `${JSON.stringify({ android: release }, null, 2)}\n`);
  // 3. The one link that's always the newest.
  copyAtomic(apk, path.join(dir, 'voicaw.apk'));
  // 4. The download page and its pictures (the same as publish.mjs copies).
  for (const file of fs.readdirSync(path.join(here, 'site'))) {
    copyAtomic(path.join(here, 'site', file), path.join(siteDir, file));
  }
  copyAtomic(path.join(root, 'client/public/logo192.png'), path.join(siteDir, 'logo.png'));
  copyAtomic(path.join(root, 'client/public/favicon.ico'), path.join(siteDir, 'favicon.ico'));
  console.log(`Published ${name} to ${dir}.`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const run = async () => {
    if (command === 'next') {
      const siteDir = path.resolve(args[1] || process.env.VOICAW_UPDATES_DIR || '/opt/voicaw-updates');
      const initial = JSON.parse(fs.readFileSync(path.join(root, 'mobile/package.json'), 'utf8')).version;
      console.log(nextVersion(args[0] || 'patch', readRelease(siteDir)?.version ?? null, initial));
    } else if (command === 'publish') {
      const [apk, version, dirArg] = args;
      const siteDir = path.resolve(dirArg || process.env.VOICAW_UPDATES_DIR || '/opt/voicaw-updates');
      await publish(path.resolve(apk), version, siteDir);
    } else {
      throw new Error('usage: publish-android.mjs next <patch|minor|major|X.Y.Z> [siteDir] | publish <apk> <version> [siteDir]');
    }
  };
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
