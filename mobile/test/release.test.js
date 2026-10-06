import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { nextVersion, versionCode, publish, readRelease } from '../../updates/publish-android.mjs';
import { LEGAL, PLAY_URL, renderLegal, renderPage } from '../../website/build.mjs';

// Releasing the Android app: its version numbers, what lands on the update site (for the copies
// installed from there), and voicaw.com (Google Play's closed test, no APK).

describe('Android release versions', () => {
  it('starts from the package version, then counts up', () => {
    expect(nextVersion('patch', null, '0.1.0')).toBe('0.1.0');
    expect(nextVersion('2.0.0', null, '0.1.0')).toBe('2.0.0');
    expect(nextVersion('patch', '0.1.0')).toBe('0.1.1');
    expect(nextVersion('minor', '0.1.7')).toBe('0.2.0');
    expect(nextVersion('major', '0.9.3')).toBe('1.0.0');
    expect(nextVersion('0.3.0', '0.2.9')).toBe('0.3.0');
  });

  it('never goes backwards or past what versionCode can hold', () => {
    expect(() => nextVersion('0.1.0', '0.1.0')).toThrow(/not higher/);
    expect(() => nextVersion('0.0.9', '0.1.0')).toThrow(/not higher/);
    expect(() => nextVersion('patch', '0.1.99')).toThrow(/under 100/);
    expect(() => nextVersion('soon', '0.1.0')).toThrow(/Not a version/);
  });

  it('gives each version a higher versionCode (what Android compares)', () => {
    expect(versionCode('0.1.0')).toBe(100);
    expect(versionCode('0.1.1')).toBeGreaterThan(versionCode('0.1.0'));
    expect(versionCode('0.2.0')).toBeGreaterThan(versionCode('0.1.99'));
    expect(versionCode('1.0.0')).toBe(10000);
  });
});

describe('publishing an APK', () => {
  it('adds the version, the record and the newest link, keeping older APKs', async () => {
    const site = mkdtempSync(path.join(tmpdir(), 'voicaw-updates-'));
    const build = mkdtempSync(path.join(tmpdir(), 'voicaw-apk-'));
    const apk = (text) => {
      const file = path.join(build, `${text}.apk`);
      writeFileSync(file, text);
      return file;
    };
    await publish(apk('first'), '0.1.0', site);
    const release = await publish(apk('second build'), '0.1.1', site);

    expect(release).toMatchObject({ version: '0.1.1', versionCode: 101, file: { name: 'voicaw-0.1.1.apk', size: 12 } });
    expect(release.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readRelease(site)).toEqual(release);
    expect(readFileSync(path.join(site, 'android/voicaw.apk'), 'utf8')).toBe('second build');
    expect(readFileSync(path.join(site, 'android/voicaw-0.1.0.apk'), 'utf8')).toBe('first');
    expect(existsSync(path.join(site, 'index.html'))).toBe(true);
    // The download page doesn't offer it: new people get the app from Google Play.
    expect(readFileSync(path.join(site, 'index.html'), 'utf8')).not.toContain('/android/releases.json');
  });
});

describe('voicaw.com', () => {
  it('sends Android visitors to the Google Play test and its form, never an APK', () => {
    const page = renderPage({});
    expect(page).toContain('<template data-primary="android">');
    expect(page).toContain('href="#android-test"');
    expect(page).toContain('id="tester-form"');
    expect(page).toContain(`href="${PLAY_URL}"`);
    expect(page).not.toMatch(/\.apk|updates\.voicaw\.com\/android/);
    expect(page).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('voicaw.com policies', () => {
  it('builds the privacy policy, terms and account deletion pages, linked from the home page', () => {
    const pages = renderLegal({ APP_URL: 'https://app.voicaw.com', UPDATES_URL: 'https://updates.voicaw.com', STYLE_VERSION: 'x' });
    expect(pages.map((p) => p.file)).toEqual(['privacy/index.html', 'terms/index.html', 'delete-account/index.html']);
    for (const page of pages) {
      expect(page.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      for (const other of LEGAL) expect(page.html).toContain(`href="/${other.slug}/"`);
    }
    expect(pages[2].html).toContain('Settings → My Account → Delete Account');
    // Who runs it and how to reach them are filled in: nothing shows as "not set".
    for (const page of pages) expect(page.html).not.toContain('not set]');
    expect(pages[0].html).toContain('<a href="mailto:voicaw@proton.me">voicaw@proton.me</a>');
    expect(pages[1].html).toContain('the law of Jersey');
    expect(pages[1].html).toContain('at least 13');
    const home = renderPage({});
    expect(home).toContain('href="/privacy/"');
    expect(home).toContain('href="/terms/"');
  });
});
