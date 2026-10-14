import axios from 'axios';
import { loadDoc, saveDoc } from '../services/offlineCopy';
import { isOfflineMode, isUnreachable } from './offlineMode';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

// The saved login, unless the request already says which one (logout's last requests carry
// the token being logged out: sent late, after logging in again, they'd otherwise end the new
// session).
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// The server sends a new login token once the current one is a day old (server/auth.js),
// so a session lasts as long as the app is used. It's only kept if it renews the token this
// request was sent with: not after a logout, or once someone else has logged in.
api.interceptors.response.use(res => {
  const renewed = res.headers?.['x-voicaw-token'];
  const sentWith = res.config?.headers?.Authorization;
  if (renewed && sentWith && sentWith === `Bearer ${localStorage.getItem('token')}`) {
    localStorage.setItem('token', renewed);
  }
  return res;
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

// The account id in a login token ("Bearer <JWT>"; only read, the server checks it).
function accountOf(authorization) {
  try {
    const payload = authorization?.split(' ')[1]?.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).id ?? null;
  } catch {
    return null;
  }
}

api.interceptors.response.use((res) => {
  const name = offlineName(res.config);
  const sentWith = res.config?.headers?.Authorization;
  // Not after a logout (the copy is gone) or once someone else has logged in.
  if (name && sentWith && sentWith === `Bearer ${localStorage.getItem('token')}`) {
    saveDoc(accountOf(sentWith), name, res.data).catch(() => {});
  }
  return res;
}, async (err) => {
  const config = err?.config;
  const name = offlineName(config);
  const wanted = config?.offlineCopy === 'fallback' || (config?.offlineCopy !== 'never' && isOfflineMode());
  if (name && wanted && isUnreachable(err)) {
    const data = await loadDoc(accountOf(config.headers?.Authorization), name).catch(() => undefined);
    if (data !== undefined) return { data, status: 200, statusText: 'OK', headers: {}, config, fromOfflineCopy: true };
  }
  throw err;
});

console.log('API Base URL:', import.meta.env.VITE_API_BASE_URL);

export default api;