import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../i18n';

// A test that looks up a translation that doesn't exist fails, including keys built at run time
// (t(`guildAdmin.permissions.${name}.label`)), which i18n/keys.test.js can't see.
const missingKeys = [];
i18n.options.saveMissing = true;
i18n.options.missingKeyHandler = (_languages, _namespace, key) => missingKeys.push(key);

afterEach(() => {
  cleanup();
  if (missingKeys.length) throw new Error(`Missing translations: ${missingKeys.splice(0).join(', ')}`);
});

// MessageList watches row sizes via ResizeObserver, which jsdom doesn't implement.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// ProseMirror measures the selection to scroll it into view; jsdom has no layout.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
}
if (typeof document !== 'undefined' && !document.elementFromPoint) {
  document.elementFromPoint = () => null;
}
