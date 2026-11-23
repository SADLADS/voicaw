import axios from 'axios';
import { loadDoc, saveDoc } from '../services/offlineCopy';
import { isOfflineMode, isUnreachable } from './offlineMode';
import { announceLoginReplaced, cookieMode, loginHeaders, loginReplaced, sameLogin, sameSaved, savedLogin, saveLogin } from './loginToken';
import { apiBaseUrl } from './server';
import { noteRequestAnswered, noteRequestUnanswered } from './connection';
import { errorKind } from './errors';
import { hasNativeApi, nativeAdapter } from './androidApi';

const api = axios.create({
  baseURL: apiBaseUrl(),
  // The Android app makes the requests itself, with the login it keeps (utils/androidApi.js).
  ...(cookieMode() && hasNativeApi() ? { adapter: nativeAdapter } : {}),
});

// The saved login (utils/loginToken.js), unless the request already says which one (`login`:
// logout's last requests carry the login being logged out: sent late, after logging in again,
// they'd otherwise end the new session; the server refuses them, 409, if the cookie is a newer
// login's). Logged out, a request that logs in asks for the cookie (cookie mode).
api.interceptors.request.use(config => {
  if (config.login === undefined) config.login = savedLogin();
  const { login } = config;
  if (login) {
    if (!config.headers.Authorization && !config.headers['X-Voicaw-Session']) {
      for (const [name, value] of Object.entries(loginHeaders(login))) config.headers[name] = value;
    }
    if (!login.token) config.withCredentials = true;
  } else if (cookieMode()) {
    config.headers['X-Voicaw-Login'] = 'cookie';
    config.withCredentials = true;
  }
  return config;
});

// The server sends a new login token once the current one is a day old (server/auth.js),
// so a session lasts as long as the app is used. It's only kept if it renews the token this
// request was sent with: not after a logout, or once someone else has logged in.
// Whether Voicaw answers (utils/connection.js: the connection strip). Before the offline
// copy's interceptor, so an answer from the copy doesn't count as one from the server.
api.interceptors.response.use((res) => {
  noteRequestAnswered();
  return res;
}, (err) => {
  if (err?.code !== 'ERR_CANCELED' && errorKind(err) === 'offline') noteRequestUnanswered();
  else if (err?.response) noteRequestAnswered();
  throw err;
});

// (A login in the cookie is renewed in the cookie: nothing for the page to do.) A 409
// `login_changed` says another login replaced this page's: if the device has another one saved,
// the page reloads with it (App).
api.interceptors.response.use(res => {
  const renewed = res.headers?.['x-voicaw-token'];
  const sentWith = res.config?.login;
  if (renewed && sentWith?.token && sameSaved(sentWith, savedLogin())) {
    saveLogin({ token: renewed });
  }
  return res;
}, (err) => {
  if (loginReplaced(err)) {
    const now = savedLogin();
    if (now && !sameLogin(now, err.config?.login)) announceLoginReplaced();
  }
  throw err;
});

// The offline copy's lists (services/offlineCopy.js): these GETs' answers are saved, for the
// account the request was sent as, and given back when the server can't be reached, in
// offline mode only (utils/offlineMode.js) or when the request asks (`offlineCopy:
// 'fallback'`: AuthProvider's first /profile, which is what starts offline mode). `offlineCopy:
// 'never'` always asks the server. Online, nothing changes but the saving.
const OFFLINE_GETS = [
  /^\/profile$/, /^\/config$/, /^\/dms-list$/, /^\/dm-get-unread$/, /^\/group-dms$/, /^\/group-dms\/[\w-]+$/,
  /^\/conversation-settings$/, /^\/preferences$/, /^\/blocks$/, /^\/friends$/,
];

const offlineName = (config) => {
  if ((config?.method ?? 'get').toLowerCase() !== 'get' || config.params) return null;
  const url = (config.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api(?=\/)/, '');
  return OFFLINE_GETS.some((pattern) => pattern.test(url)) ? url : null;
};

// The account a request was sent as.
const accountOf = (config) => config?.login?.id ?? null;

api.interceptors.response.use((res) => {
  const name = offlineName(res.config);
  const sentWith = res.config?.login;
  // Not after a logout (the copy is gone) or once someone else has logged in.
  if (name && sentWith && sameSaved(sentWith, savedLogin())) {
    saveDoc(accountOf(res.config), name, res.data).catch(() => {});
  }
  return res;
}, async (err) => {
  const config = err?.config;
  const name = offlineName(config);
  const wanted = config?.offlineCopy === 'fallback' || (config?.offlineCopy !== 'never' && isOfflineMode());
  if (name && wanted && isUnreachable(err)) {
    const data = await loadDoc(accountOf(config), name).catch(() => undefined);
    if (data !== undefined) return { data, status: 200, statusText: 'OK', headers: {}, config, fromOfflineCopy: true };
  }
  throw err;
});

console.log('API Base URL:', apiBaseUrl());

export default api;