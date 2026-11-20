// The desktop app's update signatures, on the release side (electron/updateSignature.js has the
// format): the installers a folder's latest*.yml feeds name, signing each one
// (updates/sign-desktop.mjs) and checking every one is signed before publishing
// (updates/publish.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fileSha512, signUpdate, verifyUpdate, UPDATE_PUBLIC_KEY } = require('../electron/updateSignature.js');

export const FEED = /^latest(-[a-z0-9]+)?\.yml$/;

export function feedVersion(feedText) {
    return /^version:\s*['"]?([^'"\s]+)/m.exec(feedText)?.[1] ?? null;
}

// The file names a feed points at (its files' urls and its path).
export function feedNames(feedText) {
    const names = new Set();
    for (const [, name] of feedText.matchAll(/^\s*(?:-\s*url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) names.add(name);
    return [...names];
}

// Every installer the folder's feeds name, with its feed's version: [{ feed, name, version }].
export function feedInstallers(dir) {
    const out = [];
    for (const feed of fs.readdirSync(dir).filter((n) => FEED.test(n)).sort()) {
        const text = fs.readFileSync(path.join(dir, feed), 'utf8');
        const version = feedVersion(text);
        for (const name of feedNames(text)) out.push({ feed, name, version });
    }
    return out;
}

// Writes `<installer>.sig` beside every installer the feeds name. Returns the names signed.
export async function signFolder(dir, privateKey) {
    const signed = [];
    for (const { feed, name, version } of feedInstallers(dir)) {
        if (!version) throw new Error(`${feed} has no version`);
        const sha512 = await fileSha512(path.join(dir, name));
        const tmp = path.join(dir, `.${name}.sig.tmp`);
        fs.writeFileSync(tmp, `${signUpdate({ name, version, sha512 }, privateKey)}\n`);
        fs.renameSync(tmp, path.join(dir, `${name}.sig`));
        signed.push(name);
    }
    return signed;
}

// What's wrong with the folder's signatures (missing, or not made by `key` for these files and
// versions): a list of messages, empty when everything is signed.
export async function checkFolder(dir, key = UPDATE_PUBLIC_KEY) {
    const problems = [];
    for (const { feed, name, version } of feedInstallers(dir)) {
        const sigFile = path.join(dir, `${name}.sig`);
        if (!fs.existsSync(sigFile)) {
            problems.push(`${name} (in ${feed}) has no ${name}.sig: sign it (updates/sign-desktop.mjs).`);
            continue;
        }
        const sha512 = await fileSha512(path.join(dir, name));
        if (!version || !verifyUpdate({ name, version, sha512 }, fs.readFileSync(sigFile, 'utf8'), key)) {
            problems.push(`${name}.sig doesn't sign ${name} ${version} with the app's update key.`);
        }
    }
    return problems;
}
