import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const { restoreNames, checkRelease, CheckError } = await import('../../updates/check-release.mjs');
const { signFolder } = await import('../../updates/desktopSignatures.mjs');

// Releasing the desktop app: the downloaded GitHub release checked (updates/check-release.mjs)
// and only what its feeds name published (updates/publish.mjs).

const here = path.dirname(fileURLToPath(import.meta.url));
const sha512 = (text) => crypto.createHash('sha512').update(text).digest('base64');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function release(dir, version = '1.2.3') {
    const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
    write(`Voicaw-${version}.AppImage`, 'appimage');
    write(`Voicaw.Setup.${version}.exe`, 'exe'); // as GitHub names it
    write(`Voicaw.Setup.${version}.exe.blockmap`, 'blockmap');
    write(`voicaw-${version}-unsigned.apk`, 'apk');
    write('OBS-Studio-33.0.1-Sources.tar.gz', 'obs source');
    write('latest-linux.yml', `version: ${version}\nfiles:\n  - url: Voicaw-${version}.AppImage\n    sha512: ${sha512('appimage')}\npath: Voicaw-${version}.AppImage\n`);
    write('latest.yml', `version: ${version}\nfiles:\n  - url: Voicaw Setup ${version}.exe\n    sha512: ${sha512('exe')}\npath: Voicaw Setup ${version}.exe\n`);
}

describe('checking a downloaded release (check-release.mjs)', () => {
    const obs = { name: 'OBS-Studio-33.0.1-Sources.tar.gz', sha256: sha256('obs source') };
    let base;
    let dir;
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-check-'));
        dir = path.join(base, '1.2.3');
        fs.mkdirSync(dir);
        release(dir);
    });

    it('puts back the names the feeds use', () => {
        restoreNames(dir);
        expect(fs.existsSync(path.join(dir, 'Voicaw Setup 1.2.3.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'Voicaw Setup 1.2.3.exe.blockmap'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'Voicaw.Setup.1.2.3.exe'))).toBe(false);
    });

    it('checks every file but the OBS source, then sets the OBS source and Android apart', async () => {
        restoreNames(dir);
        fs.writeFileSync(path.join(dir, 'Voicaw-1.2.3.AppImage.sig'), 'v1.from an earlier run');
        const asked = [];
        const { checked } = await checkRelease({ dir, version: '1.2.3', obs, verify: (file) => { asked.push(path.basename(file)); return true; } });
        expect(checked).toBe(6);
        expect(asked).not.toContain('OBS-Studio-33.0.1-Sources.tar.gz');
        expect(asked).not.toContain('Voicaw-1.2.3.AppImage.sig'); // ours, not GitHub's
        expect(fs.existsSync(path.join(base, 'obs-source', 'OBS-Studio-33.0.1-Sources.tar.gz'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'android', 'voicaw-1.2.3-unsigned.apk'))).toBe(true);
    });

    it('stops at the first file whose attestation fails, moving nothing', async () => {
        restoreNames(dir);
        const asked = [];
        const verify = (file) => { asked.push(path.basename(file)); return !file.endsWith('.AppImage'); };
        await expect(checkRelease({ dir, version: '1.2.3', obs, verify })).rejects.toThrow(/Voicaw-1\.2\.3\.AppImage: its attestation/);
        expect(asked.at(-1)).toBe('Voicaw-1.2.3.AppImage');
        expect(asked).not.toContain('latest-linux.yml'); // it stopped there
        expect(fs.existsSync(path.join(dir, 'voicaw-1.2.3-unsigned.apk'))).toBe(true);
        expect(fs.existsSync(path.join(base, 'obs-source'))).toBe(false);
    });

    it('refuses an OBS source that isn\'t the pinned one, or any when none is pinned', async () => {
        restoreNames(dir);
        const verify = () => true;
        await expect(checkRelease({ dir, version: '1.2.3', obs: { ...obs, sha256: sha256('other') }, verify })).rejects.toThrow(CheckError);
        await expect(checkRelease({ dir, version: '1.2.3', obs: null, verify })).rejects.toThrow(/OBS source/);
    });

    it('refuses feeds of another version, or naming a missing file', async () => {
        const verify = () => true;
        await expect(checkRelease({ dir, version: '1.2.4', obs, verify })).rejects.toThrow(/says 1\.2\.3, not 1\.2\.4/);
        // Without the names put back, latest.yml points at a file that isn't there.
        await expect(checkRelease({ dir, version: '1.2.3', obs, verify })).rejects.toThrow(/names Voicaw Setup 1\.2\.3\.exe/);
    });
});

describe('publishing a release (publish.mjs)', () => {
    it('publishes only what the feeds name, with blockmaps and signatures', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-publish-'));
        const dir = path.join(base, 'build');
        const site = path.join(base, 'site');
        fs.mkdirSync(dir);
        release(dir);
        restoreNames(dir);
        fs.rmSync(path.join(dir, 'OBS-Studio-33.0.1-Sources.tar.gz'));
        fs.writeFileSync(path.join(dir, 'Voicaw Setup 0.9.0.exe'), 'an old installer lying about');
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        await signFolder(dir, privateKey);
        const env = { ...process.env, VOICAW_UPDATE_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
        delete env.VOICAW_SITE_DIR;
        const out = execFileSync(process.execPath, [path.join(here, '../../updates/publish.mjs'), dir, site], { env, encoding: 'utf8' });
        expect(out).toMatch(/Not published \(no feed names them\): .*Voicaw Setup 0\.9\.0\.exe/);
        expect(fs.readdirSync(path.join(site, 'desktop')).sort()).toEqual([
            'Voicaw Setup 1.2.3.exe', 'Voicaw Setup 1.2.3.exe.blockmap', 'Voicaw Setup 1.2.3.exe.sig',
            'Voicaw-1.2.3.AppImage', 'Voicaw-1.2.3.AppImage.sig', 'latest-linux.yml', 'latest.yml', 'releases.json',
        ]);
    });
});
