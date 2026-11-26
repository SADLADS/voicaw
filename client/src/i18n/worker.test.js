import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe("the service worker's i18n", () => {
  it('has British English straight away, without awaiting anything', async () => {
    const { t, resources, LANGUAGE } = await import('./worker.js');
    expect(t('media.pdf.open')).toBe('Open');
    expect(Object.keys(resources)).toContain('en-GB');
    expect(Object.keys(resources)).toContain(LANGUAGE);
  });

  it('awaits nothing (a top-level await would stop the service worker from starting)', () => {
    for (const file of ['worker.js', 'core.js']) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bawait\b/);
    }
  });
});
