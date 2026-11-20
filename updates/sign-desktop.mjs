#!/usr/bin/env node
// Signs a desktop release's installers for the app's update check (electron/updateSignature.js),
// on the machine that checked their attestations, never on the update host (README "Desktop app"):
//
//   node updates/sign-desktop.mjs <buildDir>
//
// Writes `<installer>.sig` beside every installer the folder's latest*.yml feeds name, then
// checks them against the public key built into the app, so a release signed with some other
// key stops here instead of being refused by every app. Key: ~/.voicaw-desktop-update-key/
// update-key.pem (or VOICAW_DESKTOP_UPDATE_KEY's folder), made once by make-update-key.mjs.
// VOICAW_UPDATE_KEY: the public key of a build for another update site (builder.config.js), to
// check against instead of the built-in one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkFolder, feedInstallers, signFolder } from './desktopSignatures.mjs';

const buildDir = process.argv[2] && path.resolve(process.argv[2]);
if (!buildDir || !fs.existsSync(buildDir)) {
    console.error('usage: node updates/sign-desktop.mjs <buildDir>');
    process.exit(1);
}
const keyDir = path.resolve(process.env.VOICAW_DESKTOP_UPDATE_KEY || path.join(os.homedir(), '.voicaw-desktop-update-key'));
const keyFile = path.join(keyDir, 'update-key.pem');
if (!fs.existsSync(keyFile)) {
    console.error(`No update key at ${keyFile}: make it once with node updates/make-update-key.mjs (and back it up).`);
    process.exit(1);
}
if (!feedInstallers(buildDir).length) {
    console.error(`Nothing to sign in ${buildDir} (no latest*.yml naming installers).`);
    process.exit(1);
}
for (const name of await signFolder(buildDir, fs.readFileSync(keyFile, 'utf8'))) console.log(`  ${name}.sig`);
const problems = await checkFolder(buildDir, process.env.VOICAW_UPDATE_KEY || undefined);
if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error('The app\'s update key (electron/updateSignature.js, or VOICAW_UPDATE_KEY) isn\'t this one: installed apps would refuse these.');
    process.exit(1);
}
console.log(`Signed ${buildDir}.`);
