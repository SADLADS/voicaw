#!/usr/bin/env node
// Makes the desktop app's update signing key, once (not once per machine; README "Desktop app"):
//
//   node updates/make-update-key.mjs [dir]
//
// dir: default ~/.voicaw-desktop-update-key (or VOICAW_DESKTOP_UPDATE_KEY). Writes
// update-key.pem there (Ed25519, PKCS#8, readable only by you) and prints the public half, which
// goes in electron/updateSignature.js's UPDATE_PUBLIC_KEY. Keep it off the update host and back
// it up: an app only installs updates signed with the key it was built with, so without it
// everyone would have to reinstall by hand. Refuses to overwrite a key that's already there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || process.env.VOICAW_DESKTOP_UPDATE_KEY || path.join(os.homedir(), '.voicaw-desktop-update-key'));
const file = path.join(dir, 'update-key.pem');
if (fs.existsSync(file)) {
    console.error(`${file} already exists: not overwriting it.`);
    process.exit(1);
}
process.umask(0o077);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
console.log(`Made ${file} (back it up, and keep it off the update host).`);
console.log(`Public key, for electron/updateSignature.js UPDATE_PUBLIC_KEY:\n${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`);
