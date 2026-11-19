// The desktop app's pages come from the client build shipped inside the app, served at
// voicaw://app/ rather than from file:// (or the website). That gives them a real origin
// (the API allows it for CORS, and web security stays on), and the code that holds the keys
// is the code that was installed, not whatever a server sends today.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SCHEME = 'voicaw';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;

// Whether a permission check's origin is the app's. Electron gives some checks (the
// microphone's, which decides whether the page may see device names) as a URL with a
// trailing slash: voicaw://app/.
const isAppOrigin = (origin) => (origin ?? '').replace(/\/$/, '') === ORIGIN;

// Registered before the app is ready: a standard, secure scheme (so WebCrypto, workers,
// fetch, IndexedDB and media all work as on https).
function registerScheme(protocol) {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    }]);
}

// The file for a URL path in `root`, or index.html for an app route (the app uses real paths,
// /dm/5 etc.). null: not ours, or a missing file (a 404, not the page, so a missing script
// fails loudly). Never outside `root`.
function resolveAppFile(root, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    const file = path.normalize(path.join(root, decoded));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    const last = decoded.split('/').pop();
    return last.includes('.') ? null : path.join(root, 'index.html');
}

// The Content-Security-Policy every page of ours is served with (security audit, 2026-11-18): only
// the app's own script files (and the page's own inline scripts, by hash), so an address such
// as `javascript:` slipped into the page never runs, and with it all that preload.js lets the
// page do. The same as the build's meta tag (client/vite.config.js), which index.html and
// overlay.html also carry; as a header it covers every page (popout.html too) and can forbid
// framing.
function pagePolicy(html) {
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(([, body]) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
    return [`script-src 'self' 'wasm-unsafe-eval'${hashes.map((h) => ` ${h}`).join('')}`, "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"].join('; ');
}

function handleScheme(protocol, net, root) {
    protocol.handle(SCHEME, async (request) => {
        const url = new URL(request.url);
        const file = url.host === HOST ? resolveAppFile(root, url.pathname) : null;
        if (!file) return new Response('Not found', { status: 404 });
        if (file.endsWith('.html')) {
            const html = await fs.promises.readFile(file, 'utf8');
            return new Response(html, {
                headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pagePolicy(html) },
            });
        }
        return net.fetch(pathToFileURL(file).toString());
    });
}

module.exports = { SCHEME, ORIGIN, isAppOrigin, registerScheme, handleScheme, resolveAppFile, pagePolicy };
