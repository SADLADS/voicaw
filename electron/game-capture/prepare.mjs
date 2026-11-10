// Fetches OBS's game capture files (Game capture in docs/desktop-and-site.md) into
// electron/game-capture/dist/, beside voicaw-capture.exe, for the Windows build to ship
// (builder.config.js): OBS 33.0.1's official Windows zip, checked against its published SHA-256,
// from which only the hook, inject helper and offsets programs (32- and 64-bit, code-signed as
// OBS ships them) and OBS's licence are taken, unmodified. They're GPL v2: SOURCE-OBS.txt says where their
// source is (the release workflow also attaches it to every release).
//
//   node electron/game-capture/prepare.mjs
//
// The zip (224 MB) is kept in ~/.cache/voicaw/ (VOICAW_CACHE overrides) and not fetched again.
// No other tools: a small zip reader below (stored and deflated entries, as OBS's are).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OBS_VERSION = '33.0.1';
const ZIP_NAME = `OBS-Studio-${OBS_VERSION}-Windows-x64.zip`;
const ZIP_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/${ZIP_NAME}`;
const ZIP_SHA256 = '0d9436451c2d772b33428e3fdae9776f071895c335de17283176306fb72651d3';
export const SOURCE_NAME = `OBS-Studio-${OBS_VERSION}-Sources.tar.gz`;
export const SOURCE_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/${SOURCE_NAME}`;
export const SOURCE_SHA256 = 'c8d3a8f69a0f17970ac0a8f2a2462f1bc4dacd324f6da0c4b408d442d4798913';

// Zip entry → the name it gets in dist/.
export const FILES = {
    'core/win-capture/data/graphics-hook64.dll': 'graphics-hook64.dll',
    'core/win-capture/data/graphics-hook32.dll': 'graphics-hook32.dll',
    'core/win-capture/data/inject-helper64.exe': 'inject-helper64.exe',
    'core/win-capture/data/inject-helper32.exe': 'inject-helper32.exe',
    'core/win-capture/data/get-graphics-offsets64.exe': 'get-graphics-offsets64.exe',
    'core/win-capture/data/get-graphics-offsets32.exe': 'get-graphics-offsets32.exe',
    'data/obs-studio/license/gplv2.txt': 'LICENSE-OBS.txt',
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(url, file) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const partial = `${file}.part`;
    await fs.promises.writeFile(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, file);
}

// The named entries of a zip file, read through its central directory.
export function readZipEntries(zip, wanted) {
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Not a zip file');
    const count = zip.readUInt16LE(eocd + 10);
    let at = zip.readUInt32LE(eocd + 16);
    const found = new Map();
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad zip directory');
        const method = zip.readUInt16LE(at + 10);
        const compressed = zip.readUInt32LE(at + 20);
        const size = zip.readUInt32LE(at + 24);
        const nameLength = zip.readUInt16LE(at + 28);
        const extraLength = zip.readUInt16LE(at + 30);
        const commentLength = zip.readUInt16LE(at + 32);
        const local = zip.readUInt32LE(at + 42);
        const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;
        if (!wanted.includes(name)) continue;
        if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad zip entry ${name}`);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + compressed);
        const bytes = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
        if (!bytes) throw new Error(`${name}: unsupported compression ${method}`);
        if (bytes.length !== size) throw new Error(`${name}: wrong size`);
        found.set(name, bytes);
    }
    return found;
}

export async function prepare({ out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'), cache = process.env.VOICAW_CACHE || path.join(os.homedir(), '.cache', 'voicaw') } = {}) {
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(out, { recursive: true });
    const zipFile = path.join(cache, ZIP_NAME);
    if (!fs.existsSync(zipFile) || sha256(zipFile) !== ZIP_SHA256) {
        console.log(`Downloading ${ZIP_URL}`);
        await download(ZIP_URL, zipFile);
    }
    const got = sha256(zipFile);
    if (got !== ZIP_SHA256) {
        fs.rmSync(zipFile, { force: true });
        throw new Error(`${ZIP_NAME} has SHA-256 ${got}, not ${ZIP_SHA256}`);
    }
    const entries = readZipEntries(fs.readFileSync(zipFile), Object.keys(FILES));
    for (const [entry, name] of Object.entries(FILES)) {
        const bytes = entries.get(entry);
        if (!bytes) throw new Error(`${ZIP_NAME} has no ${entry}`);
        fs.writeFileSync(path.join(out, name), bytes);
    }
    fs.writeFileSync(path.join(out, 'SOURCE-OBS.txt'), [
        `Game capture in Voicaw uses these files from OBS Studio ${OBS_VERSION}, unmodified:`,
        ...Object.values(FILES).filter((name) => name !== 'LICENSE-OBS.txt').map((name) => `  ${name}`),
        '',
        'OBS Studio is free software under the GNU General Public License, version 2',
        '(LICENSE-OBS.txt). Their complete source code is OBS Studio\'s source release:',
        `  ${SOURCE_URL}`,
        `  SHA-256 ${SOURCE_SHA256}`,
        'which is also attached to every Voicaw desktop release on GitHub. The files were taken',
        `from ${ZIP_URL}`,
        `(SHA-256 ${ZIP_SHA256}).`,
        '',
        'voicaw-capture.exe, which talks to them, is Voicaw\'s own program.',
        '',
    ].join('\r\n'));
    console.log(`OBS ${OBS_VERSION}'s game capture files are in ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    prepare().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
