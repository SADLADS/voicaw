// The login, kept by the main process so the page never holds it (security audit follow-up,
// 2026-11-20; see server/auth.js and client/src/utils/loginToken.js). The web app keeps its
// login in an HttpOnly cookie; our voicaw:// pages are cross-site to the API, so instead of
// leaving that cookie to Chromium, this takes it out of the API's answers (logging in, a
// renewal, a logout clearing it) into loginStore.js's file and strips it, and adds the token as
// `Authorization: Bearer` to the page's requests that name their session (`X-Voicaw-Session`).
// The page only ever sees `{ id, username, sid, iat }`.
//
// Only for the built-in server's API, whose address comes from the build (voicaw-api.json,
// client/vite.config.js), never from the page: a script slipped into the page can't point the
// token at another host. A server chosen on the login screen keeps a Bearer token in the page.
const COOKIE = 'voicaw_session';
const SESSION_HEADER = 'x-voicaw-session';
const TOKEN = /^[A-Za-z0-9_\-.]{1,4096}$/;

// What a token says ({ id, username, sid, iat }), or null. Only read: the server checks it.
function claimsOf(token) {
    try {
        const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        if (!claims || typeof claims.sid !== 'string') return null;
        return { id: claims.id ?? null, username: claims.username ?? null, sid: claims.sid, iat: Number(claims.iat) || 0 };
    } catch {
        return null;
    }
}

// The API's own address from the build's voicaw-api.json text ({ api: 'https://host/api/' }):
// `{ origin, prefix }`, or null (none, not https, unreadable: then nothing here applies).
function apiFromConfig(text) {
    try {
        const api = new URL(JSON.parse(text).api);
        if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) return null;
        const pathname = api.pathname.endsWith('/') ? api.pathname : `${api.pathname}/`;
        return { origin: api.origin, prefix: `${api.origin}${pathname}` };
    } catch {
        return null;
    }
}

const headerName = (headers, wanted) => Object.keys(headers ?? {}).find((name) => name.toLowerCase() === wanted);

// `store`: loginStore.js's ({ get() → { known, token }, set(token | null) }).
function createApiLogin({ api, store }) {
    // Which session each request named, from its sending to its answer (Electron's ids).
    const named = new Map();
    const savedToken = () => {
        const { token } = store.get();
        return typeof token === 'string' && TOKEN.test(token) ? token : null;
    };

    return {
        // webRequest URL patterns (Chromium's: the path takes a trailing *).
        urls: api ? [`${api.prefix}*`] : [],
        matches: (url) => Boolean(api) && String(url).startsWith(api.prefix),

        // What the page is told: `{ known, login }`, never the token.
        pageLogin() {
            const { known } = store.get();
            const token = savedToken();
            return { known, login: token ? claimsOf(token) : null };
        },

        requestHeaders(details) {
            const headers = { ...details.requestHeaders };
            const session = headerName(headers, SESSION_HEADER);
            if (!session) return headers;
            named.set(details.id, String(headers[session]));
            if (named.size > 1000) named.delete(named.keys().next().value);
            const token = savedToken();
            // Even for a request naming an older session (logout's, sent late): the server then
            // answers that another login replaced it.
            if (token && !headerName(headers, 'authorization')) headers.Authorization = `Bearer ${token}`;
            return headers;
        },

        responseHeaders(details) {
            const sentAs = named.get(details.id);
            named.delete(details.id);
            const headers = { ...details.responseHeaders };
            const name = headerName(headers, 'set-cookie');
            if (!name) return headers;
            const lines = [].concat(headers[name]);
            const ours = lines.filter((line) => String(line).trim().startsWith(`${COOKIE}=`));
            if (!ours.length) return headers;
            const rest = lines.filter((line) => !ours.includes(line));
            if (rest.length) headers[name] = rest;
            else delete headers[name];
            const value = String(ours.at(-1)).trim().slice(COOKIE.length + 1).split(';')[0].trim();
            // A login (no session named yet) is always taken; a renewal or a logout only for the
            // session saved now, not an answer to an older one's request arriving late.
            if (sentAs !== undefined && claimsOf(savedToken())?.sid !== sentAs) return headers;
            if (!value) store.set(null);
            else if (TOKEN.test(value)) store.set(value);
            return headers;
        },

        // A request that failed never gets an answer: forget what it named.
        forget(id) {
            named.delete(id);
        },
    };
}

module.exports = { createApiLogin, apiFromConfig, claimsOf, COOKIE };
