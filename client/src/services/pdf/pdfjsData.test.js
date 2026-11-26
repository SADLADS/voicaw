import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPdfjsDataPath, keepPdfDataOffline, PDFJS_CACHE } from './pdfjsData';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPdfjsDataPath', () => {
  it("knows PDF.js's data files and their list, nothing else", () => {
    expect(isPdfjsDataPath('/pdfjs/cmaps/UniJIS-UCS2-H.bcmap')).toBe(true);
    expect(isPdfjsDataPath('/pdfjs/standard_fonts/FoxitSerif.pfb')).toBe(true);
    expect(isPdfjsDataPath('/pdfjs/wasm/openjpeg.wasm')).toBe(true);
    expect(isPdfjsDataPath('/pdfjs/files.json')).toBe(true);
    expect(isPdfjsDataPath('/pdfjs/other/x.bin')).toBe(false);
    expect(isPdfjsDataPath('/pdfjs/cmaps/../index.html')).toBe(false);
    expect(isPdfjsDataPath('/assets/pdfjs-abc.js')).toBe(false);
  });
});

describe('keepPdfDataOffline', () => {
  it('does nothing without a service worker (the desktop and Android apps have the files)', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await keepPdfDataOffline()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches only the files this device has not kept yet, in its version\'s cache', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } });
    const kept = new Set(['/pdfjs/cmaps/A.bcmap']);
    const open = vi.fn(async () => ({ match: async (url) => (kept.has(url) ? {} : undefined) }));
    vi.stubGlobal('caches', { open });
    const fetchSpy = vi.fn(async (url) => (url.endsWith('files.json')
      ? { ok: true, json: async () => ['cmaps/A.bcmap', 'cmaps/B.bcmap', 'wasm/openjpeg.wasm', '../evil'] }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await keepPdfDataOffline()).toBe(2);
    expect(open).toHaveBeenCalledWith(PDFJS_CACHE);
    expect(PDFJS_CACHE).toMatch(/^pdfjs-\d+\.\d+\.\d+$/);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(['/pdfjs/files.json', '/pdfjs/cmaps/B.bcmap', '/pdfjs/wasm/openjpeg.wasm']);
  });

  it('never throws when offline', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } });
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }) });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    expect(await keepPdfDataOffline()).toBe(0);
  });
});
