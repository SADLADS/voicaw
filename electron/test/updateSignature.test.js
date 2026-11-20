import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
    UPDATE_PUBLIC_KEY, fileSha512, signUpdate, verifyUpdate, checkDownloadedUpdate,
} = require('../updateSignature.js');
const { signFolder, checkFolder } = await import('../../updates/desktopSignatures.mjs');

// Signed updates: the release key signs each installer, the app checks before installing.

function testKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const sha = (text) => crypto.createHash('sha512').update(text).digest('base64');

describe('update signatures (updateSignature.js)', () => {
    const { privateKey, key } = testKey();
    const details = { name: 'Voicaw-1.2.3.AppImage', version: '1.2.3', sha512: sha('the app') };

    it('built-in key is an Ed25519 public key', () => {
        const parsed = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
        expect(parsed.asymmetricKeyType).toBe('ed25519');
    });

    it('verifies what the key signed, and nothing else', () => {
        const sig = signUpdate(details, privateKey);
        expect(sig.startsWith('v1.')).toBe(true);
        expect(verifyUpdate(details, sig, key)).toBe(true);
        expect(verifyUpdate(details, `${sig}\n`, key)).toBe(true);
        expect(verifyUpdate({ ...details, sha512: sha('something else') }, sig, key)).toBe(false);
        expect(verifyUpdate({ ...details, version: '1.2.4' }, sig, key)).toBe(false);
        expect(verifyUpdate({ ...details, name: 'voicaw_1.2.3_amd64.deb' }, sig, key)).toBe(false);
        expect(verifyUpdate(details, sig, testKey().key)).toBe(false); // another key
        expect(verifyUpdate(details, sig.slice(3), key)).toBe(false); // no version prefix
        expect(verifyUpdate(details, 'v1.AAAA', key)).toBe(false);
        expect(verifyUpdate(details, undefined, key)).toBe(false);
        // A newline can't move one field into the next.
        expect(() => signUpdate({ ...details, name: 'a\n1.2.3' }, privateKey)).toThrow();
    });

    describe('checking a download', () => {
        let dir;
        let file;
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-update-'));
            file = path.join(dir, 'pending.AppImage');
            fs.writeFileSync(file, 'the app');
        });

        const info = (overrides = {}) => ({
            version: '1.2.3',
            downloadedFile: file,
            files: [
                { url: 'voicaw_1.2.3_amd64.deb', sha512: sha('the deb') },
                { url: 'Voicaw-1.2.3.AppImage', sha512: sha('the app') },
            ],
            ...overrides,
        });
        const baseUrl = 'https://updates.example/desktop/';

        it('fetches the signature of the feed entry with the file\'s own hash', async () => {
            const asked = [];
            const fetchText = async (url) => {
                asked.push(url);
                return signUpdate(details, privateKey);
            };
            expect(await checkDownloadedUpdate(info(), { baseUrl, key, fetchText })).toBe(true);
            expect(asked).toEqual(['https://updates.example/desktop/Voicaw-1.2.3.AppImage.sig']);
        });

        it('refuses a file whose hash the feed doesn\'t list (or lists with the wrong hash)', async () => {
            fs.writeFileSync(file, 'something the feed never named');
            const fetchText = async () => signUpdate(details, privateKey);
            expect(await checkDownloadedUpdate(info(), { baseUrl, key, fetchText })).toBe(false);
        });

        it('refuses a signature for some other file or version, or none', async () => {
            const other = async () => signUpdate({ ...details, version: '1.0.0' }, privateKey);
            expect(await checkDownloadedUpdate(info(), { baseUrl, key, fetchText: other })).toBe(false);
            const missing = async () => { throw new Error('HTTP 404'); };
            expect(await checkDownloadedUpdate(info(), { baseUrl, key, fetchText: missing })).toBe(false);
            const signed = async () => signUpdate(details, privateKey);
            expect(await checkDownloadedUpdate(info(), { baseUrl, key: testKey().key, fetchText: signed })).toBe(false);
            expect(await checkDownloadedUpdate(info(), { key, fetchText: signed })).toBe(false); // no site
        });

        it('refuses feed names that aren\'t plain file names', async () => {
            const fetchText = async () => signUpdate({ ...details, name: '../Voicaw-1.2.3.AppImage' }, privateKey);
            const bad = info({ files: [{ url: '../Voicaw-1.2.3.AppImage', sha512: sha('the app') }] });
            expect(await checkDownloadedUpdate(bad, { baseUrl, key, fetchText })).toBe(false);
        });
    });
});

describe('signing a release folder (updates/desktopSignatures.mjs)', () => {
    const { privateKey, key } = testKey();
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-release-'));
        fs.writeFileSync(path.join(dir, 'Voicaw-1.2.3.AppImage'), 'the app');
        fs.writeFileSync(path.join(dir, 'voicaw_1.2.3_amd64.deb'), 'the deb');
        fs.writeFileSync(path.join(dir, 'latest-linux.yml'), [
            'version: 1.2.3',
            'files:',
            '  - url: Voicaw-1.2.3.AppImage',
            `    sha512: ${sha('the app')}`,
            '  - url: voicaw_1.2.3_amd64.deb',
            `    sha512: ${sha('the deb')}`,
            'path: Voicaw-1.2.3.AppImage',
            `sha512: ${sha('the app')}`,
            '',
        ].join('\n'));
    });

    it('signs every installer the feeds name, in the format the app checks', async () => {
        expect(await checkFolder(dir, key)).toHaveLength(2); // nothing signed yet
        expect((await signFolder(dir, privateKey)).sort()).toEqual(['Voicaw-1.2.3.AppImage', 'voicaw_1.2.3_amd64.deb']);
        expect(await checkFolder(dir, key)).toEqual([]);
        const sig = fs.readFileSync(path.join(dir, 'Voicaw-1.2.3.AppImage.sig'), 'utf8');
        const sha512 = await fileSha512(path.join(dir, 'Voicaw-1.2.3.AppImage'));
        expect(verifyUpdate({ name: 'Voicaw-1.2.3.AppImage', version: '1.2.3', sha512 }, sig, key)).toBe(true);
        expect(await checkFolder(dir, testKey().key)).toHaveLength(2); // not the app's key
    });

    it('notices an installer changed after signing', async () => {
        await signFolder(dir, privateKey);
        fs.writeFileSync(path.join(dir, 'voicaw_1.2.3_amd64.deb'), 'another deb');
        const problems = await checkFolder(dir, key);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/voicaw_1\.2\.3_amd64\.deb/);
    });
});
