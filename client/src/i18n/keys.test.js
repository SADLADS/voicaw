import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_LANGUAGE as LANGUAGE, LANGUAGES, resources, t } from './index.js';

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['deepfilter', 'i18n'].includes(name) ? [] : sourceFiles(path);
    return /\.jsx?$/.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

// Keys written out in full: t('a.b'), t("a.b", ...), <Trans i18nKey="a.b">. Keys built at run
// time (t(`permissions.${name}`)) can't be checked here.
function usedKeys() {
  const keys = new Map();
  const pattern = /(?:\bt\(\s*|i18nKey=\{?\s*)(['"])([a-zA-Z0-9_.-]+)\1/g;
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.set(match[2], file);
  }
  return keys;
}

function lookup(key) {
  return key.split('.').reduce((node, part) => node?.[part], resources[LANGUAGE].translation);
}

describe('translations', () => {
  it('has every key the code uses', () => {
    const missing = [];
    for (const [key, file] of usedKeys()) {
      // A plural (key_one, key_other) is looked up with a count.
      const found = lookup(key) ?? lookup(`${key}_other`);
      if (typeof found !== 'string') missing.push(`${key} (${file.slice(SRC.length + 1)})`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps each area in its own file, in every language', () => {
    for (const { code } of LANGUAGES) {
      const dir = join(import.meta.dirname, code);
      for (const name of readdirSync(dir)) {
        const keys = Object.keys(JSON.parse(readFileSync(join(dir, name), 'utf8')));
        expect(keys, `${code}/${name}`).toEqual([basename(name, '.json')]);
      }
    }
  });

  it('looks strings up synchronously', () => {
    expect(t('common.cancel')).toBe('Cancel');
  });
});
