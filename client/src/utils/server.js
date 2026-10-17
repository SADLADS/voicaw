import { getSetting, setSetting } from '../services/settingsStore';

// Which Voicaw server this app talks to: the one it was built for (VITE_API_BASE_URL and
// VITE_WS_URL), or another chosen on the login screen ({ api, ws }, `localStorage server`, also
// in settingsStore for the service worker, which can't read localStorage). Chosen while logged
// out only, and the page reloads onto it, so everything below is read once.

const STORAGE_KEY = 'server';
const BUILT_IN = { api: import.meta.env.VITE_API_BASE_URL, ws: import.meta.env.VITE_WS_URL };
// How long the login screen waits for a server to answer before saying it can't reach it.
const CHECK_TIMEOUT_MS = 10000;

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);
const absolute = (url) => {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
};

// A saved choice, if it's still a well-formed one.
function cleanServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const api = new URL(raw.api);
    const ws = new URL(raw.ws);
    if (!/^https?:$/.test(api.protocol) || !/^wss?:$/.test(ws.protocol)) return null;
    return { api: withSlash(api.href), ws: ws.href };
  } catch {
    return null;
  }
}

function readSaved() {
  try {
    return cleanServer(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

const chosen = readSaved();

// The API's address ("https://app.voicaw.com/api/"), what every request starts with.
export const apiBaseUrl = () => chosen?.api ?? BUILT_IN.api;

// The app's websocket.
export const websocketUrl = () => chosen?.ws ?? BUILT_IN.ws;

// Whether this is the server the app was built for (voicaw.com's, in the builds we publish).
export const isBuiltInServer = () => !chosen;

// The server's name for the login screen: its address's host ("chat.example.com").
export function serverHost(api = apiBaseUrl()) {
  try {
    return new URL(api, globalThis.location?.href).host;
  } catch {
    return String(api);
  }
}

// The built-in server's name ("app.voicaw.com"), for going back to it.
export const builtInServerHost = () => serverHost(BUILT_IN.api);

// What keeps data this device stores across logins apart per server (user ids are only unique
// on one server): nothing for the built-in server, so what's already stored stays where it is,
// "@host" for any other. Sync, for the page.
export const serverSuffix = () => (chosen ? `@${serverHost()}` : '');

// The same from the service worker too (async: it reads settingsStore).
export async function serverSuffixAnywhere() {
  if (typeof localStorage !== 'undefined') return serverSuffix();
  const saved = cleanServer(await getSetting(STORAGE_KEY));
  return saved ? `@${serverHost(saved.api)}` : '';
}

// The API's address for the service worker (pushsubscriptionchange).
export async function apiBaseUrlAnywhere() {
  if (typeof localStorage !== 'undefined') return apiBaseUrl();
  return cleanServer(await getSetting(STORAGE_KEY))?.api ?? BUILT_IN.api;
}

// What someone typed as a server ("chat.example.com", "https://example.com/voicaw/api/"...)
// as the API's address, or null. No scheme means https; a path is where the server's /api/ is.
export function apiUrlFromInput(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}/api/`;
}

// The websocket of a server whose /api/config doesn't name one: /api/socket on the same host
// (the server takes the app's websocket on any path but /api/gateway, so a proxy forwarding
// /api/ with websocket upgrades is enough).
function defaultWebsocketUrl(api) {
  const url = new URL('socket', api);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.href;
}

// Asks the server at what was typed for its config, to check it's a Voicaw server. Resolves to
// { api, ws, host }, or throws an Error whose `code` is 'invalid_address' or 'unreachable'.
export async function findServer(input, { fetchImpl = globalThis.fetch } = {}) {
  const api = apiUrlFromInput(input);
  if (!api) throw Object.assign(new Error('Not a server address'), { code: 'invalid_address' });
  let config;
  try {
    const res = await fetchImpl(new URL('config', api).href, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (err) {
    throw Object.assign(new Error(`Couldn't reach ${api}: ${err.message}`), { code: 'unreachable' });
  }
  // Every Voicaw server's config has these (server/index.js).
  if (!config || typeof config !== 'object' || !('signupMode' in config) || !('termsVersion' in config)) {
    throw Object.assign(new Error(`${api} isn't a Voicaw server`), { code: 'unreachable' });
  }
  let ws = defaultWebsocketUrl(api);
  if (typeof config.websocketUrl === 'string') {
    try {
      const named = new URL(config.websocketUrl, api);
      if (/^wss?:$/.test(named.protocol)) ws = named.href;
    } catch { /* keep the default */ }
  }
  return { api, ws, host: serverHost(api) };
}

// Whether `server` ({ api }) is the built-in one, typed in again.
export const isBuiltIn = (server) => absolute(withSlash(BUILT_IN.api ?? '')) === server?.api;

// Saves the server to use from the next page load: { api, ws }, or null for the built-in one.
export async function saveServer(server) {
  const value = server && !isBuiltIn(server) ? { api: server.api, ws: server.ws } : null;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked: stays on this one */ }
  await setSetting(STORAGE_KEY, value).catch(() => {});
}
