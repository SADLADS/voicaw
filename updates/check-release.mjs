#!/usr/bin/env node
// Checks a release downloaded from GitHub before anything of it is published, then signs the
// desktop installers (README "Desktop app", step 4):
//
//   node updates/check-release.mjs <dir> <X.Y.Z> [--no-sign]
//
// dir: the release's files (`gh release download desktop-vX.Y.Z --dir dist-release/X.Y.Z`). In
// order, stopping at the first problem (exit 1) so nothing half-checked gets published:
// 1. GitHub's dotted names ("Voicaw.Setup.1.2.3.exe") back to the ones the feeds name, and their
//    blockmaps.
// 2. OBS Studio's source archive (game capture's source, not built by the workflow, so without
//    an attestation) must be the one pinned in electron/game-capture/prepare.mjs at the tag's
//    commit, by name and SHA-256; it's moved to <dir>/../obs-source (never published).
// 3. Every other file's attestation: built by .github/workflows/desktop-release.yml, from the
//    desktop-vX.Y.Z tag and its commit, on GitHub's own machines (`gh attestation verify`).
// 4. Every feed says X.Y.Z and every file it names is there.
// 5. The Android files (.apk, .aab) moved to <dir>/android, for mobile/sign-android.sh.
// 6. The desktop installers signed with the update key (updates/sign-desktop.mjs; --no-sign
//    skips it, e.g. on a machine without the key, which then can't publish).
// The tag must be in this checkout (git fetch origin tag desktop-vX.Y.Z). VOICAW_REPO names
// another GitHub repository (default SADLADS/voicaw).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkFolder, FEED, feedNames, feedVersion, signFolder } from './desktopSignatures.mjs';

export const WORKFLOW = 'desktop-release.yml';
const OBS_SOURCE = /^OBS-Studio-.*-Sources\.tar\.gz$/;

class CheckError extends Error {}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function feedsIn(dir) {
    return fs.readdirSync(dir).filter((n) => FEED.test(n)).sort();
}

// 1. The names the feeds use, for files GitHub renamed (spaces become dots).
export function restoreNames(dir) {
    for (const feed of feedsIn(dir)) {
        for (const name of feedNames(fs.readFileSync(path.join(dir, feed), 'utf8'))) {
            for (const file of [name, `${name}.blockmap`]) {
                const github = file.replaceAll(' ', '.');
                if (!fs.existsSync(path.join(dir, file)) && fs.existsSync(path.join(dir, github))) {
                    fs.renameSync(path.join(dir, github), path.join(dir, file));
                }
            }
        }
    }
}

// Steps 2 to 5. `obs`: { name, sha256 } pinned at the tag's commit (null: the commit had no game
// capture, so no OBS source may be in the release). `verify(file)`: whether its attestation
// checks out. Throws CheckError at the first problem.
export async function checkRelease({ dir, version, obs, verify }) {
    const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
    if (!names.length) throw new CheckError(`${dir} is empty.`);
    const feeds = names.filter((n) => FEED.test(n));
    if (!feeds.length) throw new CheckError(`${dir} has no latest*.yml: not a desktop release.`);
    let checked = 0;
    for (const name of names.sort()) {
        const file = path.join(dir, name);
        // Our own signatures, from an earlier run (signing makes them again).
        if (name.endsWith('.sig')) continue;
        if (OBS_SOURCE.test(name)) {
            if (!obs || name !== obs.name || sha256(file) !== obs.sha256) {
                throw new CheckError(`${name}: not the OBS source pinned in electron/game-capture/prepare.mjs.`);
            }
            continue;
        }
        if (!(await verify(file))) throw new CheckError(`${name}: its attestation doesn't check out.`);
        checked += 1;
    }
    for (const feed of feeds) {
        const text = fs.readFileSync(path.join(dir, feed), 'utf8');
        if (feedVersion(text) !== version) throw new CheckError(`${feed} says ${feedVersion(text)}, not ${version}.`);
        for (const name of feedNames(text)) {
            if (!names.includes(name)) throw new CheckError(`${feed} names ${name}, which isn't in ${dir}.`);
        }
    }
    // Only now that everything checked out: the OBS source and Android's files set apart.
    for (const name of names) {
        if (OBS_SOURCE.test(name)) {
            const to = path.join(dir, '..', 'obs-source');
            fs.mkdirSync(to, { recursive: true });
            fs.renameSync(path.join(dir, name), path.join(to, name));
        } else if (/\.(apk|aab)$/i.test(name)) {
            fs.mkdirSync(path.join(dir, 'android'), { recursive: true });
            fs.renameSync(path.join(dir, name), path.join(dir, 'android', name));
        }
    }
    return { checked };
}

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function main() {
    const args = process.argv.slice(2);
    const sign = !args.includes('--no-sign');
    const [dirArg, version] = args.filter((a) => a !== '--no-sign');
    if (!dirArg || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
        console.error('usage: node updates/check-release.mjs <dir> <X.Y.Z> [--no-sign]');
        process.exit(1);
    }
    const dir = path.resolve(dirArg);
    const repo = process.env.VOICAW_REPO || 'SADLADS/voicaw';
    const tag = `desktop-v${version}`;
    let commit;
    try {
        commit = git('rev-parse', `${tag}^{commit}`);
    } catch {
        console.error(`No ${tag} tag here: git fetch origin tag ${tag}`);
        process.exit(1);
    }
    try {
        execFileSync('gh', ['attestation', 'verify', '--help'], { stdio: 'ignore' });
    } catch {
        console.error('The GitHub CLI (2.49 or later, logged in) checks the attestations: README "Desktop app".');
        process.exit(1);
    }
    let obs = null;
    try {
        const prepare = git('show', `${commit}:electron/game-capture/prepare.mjs`);
        const obsVersion = /^export const OBS_VERSION = '(.*)';/m.exec(prepare)?.[1];
        const obsSha = /^export const SOURCE_SHA256 = '([0-9a-f]{64})';/m.exec(prepare)?.[1];
        if (obsVersion && obsSha) obs = { name: `OBS-Studio-${obsVersion}-Sources.tar.gz`, sha256: obsSha };
    } catch {
        // A commit from before game capture.
    }
    const verify = (file) => {
        try {
            execFileSync('gh', [
                'attestation', 'verify', file, '--repo', repo,
                '--signer-workflow', `${repo}/.github/workflows/${WORKFLOW}`,
                '--source-ref', `refs/tags/${tag}`, '--source-digest', commit,
                '--deny-self-hosted-runners',
            ], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    };
    try {
        restoreNames(dir);
        console.log(`Checking ${dir} against ${tag} (${commit.slice(0, 8)})…`);
        const { checked } = await checkRelease({ dir, version, obs, verify });
        console.log(`Every file (${checked}) was built by ${WORKFLOW} from ${commit.slice(0, 8)}.`);
    } catch (err) {
        if (!(err instanceof CheckError)) throw err;
        console.error(`${err.message} Not publishing.`);
        process.exit(1);
    }
    if (!sign) {
        console.log('Not signed (--no-sign): updates/publish.mjs will refuse it until it is.');
        return;
    }
    const keyFile = path.join(path.resolve(process.env.VOICAW_DESKTOP_UPDATE_KEY
        || path.join(os.homedir(), '.voicaw-desktop-update-key')), 'update-key.pem');
    if (!fs.existsSync(keyFile)) {
        console.error(`No update key at ${keyFile} (README "Desktop app"): checked, but not signed.`);
        process.exit(1);
    }
    await signFolder(dir, fs.readFileSync(keyFile, 'utf8'));
    const problems = await checkFolder(dir, process.env.VOICAW_UPDATE_KEY || undefined);
    if (problems.length) {
        for (const problem of problems) console.error(problem);
        process.exit(1);
    }
    console.log(`Signed. Ready: node updates/publish.mjs ${dirArg}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    await main();
}
export { CheckError };
