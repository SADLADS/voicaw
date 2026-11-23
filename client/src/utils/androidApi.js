import axios, { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { android } from './android';
import { apiBaseUrl } from './server';

// The Android app's requests to the API, made by its native side with the login it keeps
// (mobile/.../ApiLogin.java), as the desktop app's main process does (electron/apiLogin.js): the
// page never holds the token. The web app's login is an HttpOnly cookie, but the Android page
// (https://localhost) is cross-site to the API and recent WebViews never send it a cross-site
// cookie (android-v1.3.1 to 1.3.3 logged out at every start). The app's page asks through the
// Voicaw plugin; the hidden notification page (android/notifyPage.js) through its
// VoicawNotifyHost bridge. Only for the built-in server's API (the native side checks the address
// against the build's), and only in cookie mode (utils/loginToken.js): another server keeps a
// Bearer token in the page.

const notifyHost = () => (typeof window !== 'undefined' ? window.VoicawNotifyHost : null) ?? null;

// Whether this page's requests to the API go through the Android app.
export const hasNativeApi = () => Boolean(android || notifyHost()?.apiRequest);

let nextId = 1;
const waiting = new Map();

// The notification page's answers (NotifyRenderer.java calls voicawNotify.apiAnswer).
export function answerFromNotifyHost(id, json) {
  const resolve = waiting.get(id);
  if (!resolve) return;
  waiting.delete(id);
  try {
    resolve(JSON.parse(json));
  } catch {
    resolve({ error: 'bad_answer' });
  }
}

function send(request) {
  if (android) return android.apiRequest({ request: JSON.stringify(request) });
  const host = notifyHost();
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    host.apiRequest(id, JSON.stringify(request));
  });
}

// Logged out on this phone without the server: the kept token goes too.
export async function forgetNativeLogin() {
  try {
    await android?.forgetApiLogin();
  } catch { /* an older app: nothing kept */ }
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// A request body the native side can send: text as it is, anything else (FormData, a Blob) as the
// bytes and type a browser would send.
async function bodyOf(data, headers) {
  if (data == null) return {};
  if (typeof data === 'string') return { body: data };
  const encoded = new Request('https://localhost/', { method: 'POST', body: data });
  const type = encoded.headers.get('content-type');
  if (type) {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name];
    headers['Content-Type'] = type;
  }
  return { bodyBase64: toBase64(new Uint8Array(await encoded.arrayBuffer())) };
}

function abortedBy(signal, config) {
  return new Promise((_, reject) => {
    // Aborted while the body was being read: the event has already gone.
    if (signal.aborted) reject(new CanceledError(null, config));
    signal.addEventListener('abort', () => reject(new CanceledError(null, config)), { once: true });
  });
}

// An axios adapter (utils/api.js): the request made by the app, answered as axios would.
export async function nativeAdapter(config) {
  const url = axios.getUri(config);
  if (!url.startsWith(apiBaseUrl())) return axios.getAdapter(['xhr', 'fetch'])(config);
  if (config.signal?.aborted) throw new CanceledError(null, config);

  const headers = {};
  for (const [name, value] of Object.entries(AxiosHeaders.from(config.headers).toJSON())) {
    if (value != null && value !== false) headers[name] = String(value);
  }
  // Settings → Devices names the device from it, as it does the WebView's own requests.
  if (typeof navigator !== 'undefined' && !Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = navigator.userAgent;
  }
  const request = { method: (config.method ?? 'get').toUpperCase(), url, headers, timeout: config.timeout || 0, ...(await bodyOf(config.data, headers)) };

  const sending = send(request);
  const answer = await (config.signal ? Promise.race([sending, abortedBy(config.signal, config)]) : sending);
  if (!answer || answer.error) {
    if (answer?.error === 'timeout') throw new AxiosError(`timeout of ${config.timeout}ms exceeded`, AxiosError.ECONNABORTED, config);
    throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
  }
  const response = {
    data: answer.body ?? '',
    status: answer.status,
    statusText: answer.statusText ?? '',
    headers: AxiosHeaders.from(answer.headers ?? {}),
    config,
    request: null,
  };
  if (!config.validateStatus || config.validateStatus(response.status)) return response;
  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config, null, response,
  );
}
