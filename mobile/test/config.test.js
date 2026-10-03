import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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

  it('keeps the page storage (and its keys) out of Android backups', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  });
});
