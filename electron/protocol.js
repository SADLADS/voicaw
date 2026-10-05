// The desktop app's pages come from the client build shipped inside the app, served at
// voicaw://app/ rather than from file:// (or the website). That gives them a real origin
// (the API allows it for CORS, and web security stays on), and the code that holds the keys
// is the code that was installed, not whatever a server sends today.
const path = require('path');
const fs = require('fs');
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

function handleScheme(protocol, net, root) {
    protocol.handle(SCHEME, (request) => {
        const url = new URL(request.url);
        const file = url.host === HOST ? resolveAppFile(root, url.pathname) : null;
        if (!file) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

module.exports = { SCHEME, ORIGIN, isAppOrigin, registerScheme, handleScheme, resolveAppFile };
