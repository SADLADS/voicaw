// Signed updates: every installer on the update feed has a `<installer>.sig` beside it, an
// Ed25519 signature made with a key that never sits on the update host
// (updates/sign-desktop.mjs, README "Desktop app"). The app checks it before installing
// (updater.js), so whoever can write to updates.voicaw.com still can't ship code to installed
// apps. Used by the app, and by the release scripts to sign and to check before publishing.
//
// What's signed: `voicaw/desktop-update/v1`, the installer's name on the feed, its version and
// the SHA-512 of its bytes (base64, as electron-updater's feeds write it), one per line. The
// app hashes the file it downloaded itself rather than trusting the feed's hash. The .sig file
// is `v1.` and the signature in base64.
const crypto = require('crypto');
const fs = require('fs');

// The release key's public half (updates/make-update-key.mjs prints it): SPKI DER, base64.
// A build for another update site can bring its own (VOICAW_UPDATE_KEY, builder.config.js).
const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAhX8mE0UqsmVhrMGyuM9j1iboecDiAPs/tf3aREHhp3o=';
const PURPOSE = 'voicaw/desktop-update/v1';
const SIG_PREFIX = 'v1.';
// A .sig file is about 90 bytes; anything much bigger isn't one.
const MAX_SIG_BYTES = 1024;

function signedMessage({ name, version, sha512 }) {
    for (const part of [name, version, sha512]) {
        if (typeof part !== 'string' || !part || /[\r\n]/.test(part)) throw new Error('Bad update details');
    }
    return Buffer.from(`${PURPOSE}\n${name}\n${version}\n${sha512}`, 'utf8');
}

function publicKey(base64 = UPDATE_PUBLIC_KEY) {
    return crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

function fileSha512(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('base64')));
    });
}

// The .sig file's text for these details, signed with `privateKey` (a KeyObject or PEM).
function signUpdate(details, privateKey) {
    return SIG_PREFIX + crypto.sign(null, signedMessage(details), privateKey).toString('base64');
}

// Whether `sigText` (a .sig file's contents) signs these details with `key` (base64 SPKI).
function verifyUpdate(details, sigText, key = UPDATE_PUBLIC_KEY) {
    if (typeof sigText !== 'string') return false;
    const text = sigText.trim();
    if (!text.startsWith(SIG_PREFIX)) return false;
    const signature = Buffer.from(text.slice(SIG_PREFIX.length), 'base64');
    if (signature.length !== 64) return false;
    try {
        return crypto.verify(null, signedMessage(details), publicKey(key), signature);
    } catch {
        return false;
    }
}

// Checks a downloaded update (electron-updater's 'update-downloaded' event: `downloadedFile`,
// `version`, `files`): hashes the file, finds the feed's entry with that hash, fetches its
// .sig from `baseUrl` and verifies it. Resolves to true or false, never throws.
async function checkDownloadedUpdate(info, { baseUrl, key = UPDATE_PUBLIC_KEY, fetchText = fetchSig } = {}) {
    try {
        if (!info?.downloadedFile || !baseUrl) return false;
        const sha512 = await fileSha512(info.downloadedFile);
        const entry = (info.files ?? []).find((file) => file?.sha512 === sha512 && typeof file.url === 'string');
        if (!entry) return false;
        // The feed's names are plain file names next to it; anything else isn't ours.
        if (/[/\\]|^\.\.?$/.test(entry.url)) return false;
        const sigText = await fetchText(new URL(`${encodeURIComponent(entry.url)}.sig`, baseUrl).href);
        return verifyUpdate({ name: entry.url, version: info.version, sha512 }, sigText, key);
    } catch (err) {
        console.error('Update signature check failed:', err?.message);
        return false;
    }
}

// `fetchImpl`: the app passes Electron's net.fetch (the system's proxy settings, as
// electron-updater's own downloads).
async function fetchSig(url, fetchImpl = fetch) {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for the update's signature`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_SIG_BYTES) throw new Error('The update\'s signature is too big');
    return body.toString('utf8');
}

module.exports = {
    UPDATE_PUBLIC_KEY, signedMessage, fileSha512, signUpdate, verifyUpdate, checkDownloadedUpdate, fetchSig,
};
