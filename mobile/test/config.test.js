import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// The pieces of the Android app that live in other packages have to agree with
// capacitor.config.json.
const here = path.dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(readFileSync(path.join(here, '../capacitor.config.json'), 'utf8'));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');

describe('the Android app set-up', () => {
  it("serves the page from an origin the API accepts, the one the hidden page uses", () => {
    const origin = `${config.server.androidScheme}://${config.server.hostname}`;
    expect(origin).toBe('https://localhost');
    expect(read('../server/config.js')).toContain(`'${origin}'`);
    expect(read('android/app/src/main/java/com/voicaw/app/NotifyRenderer.java')).toContain(`"${origin}/notify.html"`);
  });

  it("ships the client's Android build, hidden page included", () => {
    expect(config.webDir).toBe('../build-android');
    const vite = read('../client/vite.config.js');
    expect(vite).toContain("'../build-android'");
    expect(vite).toContain("'notify.html'");
  });

  it("names itself in its user agent (Settings → Devices), with the app's version", () => {
    // A local build's version is the package's; a release's is stamped in by dist-android.sh.
    const { version } = JSON.parse(read('package.json'));
    expect(config.android.appendUserAgent).toBe(`VoicawAndroid/${version}`);
    expect(read('android/app/build.gradle')).toContain("parse(file('../../package.json')).version");
    expect(read('dist-android.sh')).toContain('appendUserAgent: `VoicawAndroid/${process.argv[2]}`');
  });

  it("updates itself only in the build from updates.voicaw.com, never Google Play's", () => {
    // Play forbids apps updating themselves, and restricts the permission to install packages.
    expect(read('android/app/src/main/AndroidManifest.xml')).not.toContain('REQUEST_INSTALL_PACKAGES');
    expect(read('android/app/src/direct/AndroidManifest.xml')).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    expect(existsSync(path.join(here, '../android/app/src/play/AndroidManifest.xml'))).toBe(false);
    const play = read('android/app/src/play/java/com/voicaw/app/AppUpdater.java');
    expect(play).not.toMatch(/PackageInstaller|HttpURLConnection/);
    // The released APK is the direct build, and its updates come from where it's published.
    // ...and the bundle for Google Play is the play build, from the same release.
    expect(read('dist-android.sh')).toContain('task="assembleDirectRelease bundlePlayRelease"');
    expect(read('android/app/build.gradle')).toContain("'https://updates.voicaw.com/android/'");
    expect(read('../updates/publish-android.mjs')).toContain("'releases.json'");
  });

  it('keeps the page storage (and its keys) out of Android backups', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  });
});
