import { version } from 'pdfjs-dist/package.json';

// PDF.js's data files (/pdfjs/<folder>/<file>, vite.config.js `pdfjsAssets`: character maps,
// standard fonts, colour profiles, image decoders) kept for offline use (PDF reader in
// docs/uploads.md). They aren't precached (~4 MB every device would download, PDF reader or
// not): the service worker keeps each one cache-first as it's fetched (service-worker.js), per
// PDF.js version, and the first PDF opened while online fetches the rest in the background
// (`keepPdfDataOffline`), so from then on any PDF draws fully without a connection. Shared by the
// page and the service worker, so kept free of PDF.js itself.

export const PDFJS_CACHE = `pdfjs-${version}`;
export const PDFJS_CACHE_PREFIX = 'pdfjs-';

// Whether a path is one of PDF.js's data files or their list.
export function isPdfjsDataPath(pathname) {
  return /\/pdfjs\/(?:(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9._-]+|files\.json)$/.test(pathname);
}

let filling = null;

// Fetches every data file this device doesn't have yet, one at a time (they're small), through
// the service worker, which keeps them. Only where a service worker controls the page (the web
// app: the desktop and Android apps have the files inside them). Resolves to how many were
// fetched; never throws.
export function keepPdfDataOffline({ base = '/' } = {}) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller || typeof caches === 'undefined') return Promise.resolve(0);
  filling ??= (async () => {
    let fetched = 0;
    try {
      const cache = await caches.open(PDFJS_CACHE);
      const list = await (await fetch(`${base}pdfjs/files.json`)).json();
      for (const file of Array.isArray(list) ? list : []) {
        const url = `${base}pdfjs/${file}`;
        if (!isPdfjsDataPath(url) || await cache.match(url)) continue;
        const res = await fetch(url, { priority: 'low' });
        if (!res.ok) continue;
        await res.arrayBuffer(); // read whole, so the service worker has it all
        fetched += 1;
      }
    } catch {
      // Offline or the like: they're kept as PDFs need them instead, and tried again next time.
    }
    filling = null;
    return fetched;
  })();
  return filling;
}
