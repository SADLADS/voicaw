import { t } from '../i18n';
import { formatDateTime } from './dateFormat';

// What went wrong, in people's words (Errors in docs/client.md). Every failure the app shows
// goes through here, never `err.message` straight from axios ("Network Error", "Request failed
// with status code 500"). The kind says whose problem it is, which decides the words and
// whether trying again can help:
//   offline    no answer, or the proxy saying the API is down (502/504, or a 503 that isn't ours)
//   timeout    asked, but no answer in time
//   server     the server answered with a 5xx of its own
//   session    401: the login is no longer valid
//   forbidden  403 · gone 404 · rate 429 · rejected any other 4xx (the server's rule)
//   device     an error thrown on this device (keys, crypto, media), already written for people
export const ERROR_KINDS = ['offline', 'timeout', 'server', 'session', 'forbidden', 'gone', 'rate', 'rejected', 'device'];

// Kinds where the same request may work a moment later.
const RETRYABLE = new Set(['offline', 'timeout', 'server', 'rate']);

const fromRequest = (err) => Boolean(err?.isAxiosError || err?.config || err?.response);

// The server's own message (always written for people, server/actionError.js).
const serverText = (err) => {
  const text = err?.response?.data?.error;
  return typeof text === 'string' && text.trim() ? text : null;
};

export function errorKind(err) {
  if (!err) return 'device';
  if (fromRequest(err)) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'timeout';
    const status = err.response?.status;
    if (!err.response || status === 502 || status === 504) return 'offline';
    // A 503 from our own server says why ("Voice isn't set up yet"); nginx's has no JSON.
    if (status === 503 && !serverText(err)) return 'offline';
    if (status >= 500) return 'server';
    if (status === 401) return 'session';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'gone';
    if (status === 429) return 'rate';
    return 'rejected';
  }
  // fetch() rejecting: the network, not a server answer.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message ?? '')) return 'offline';
  if (err.name === 'TimeoutError') return 'timeout';
  return 'device';
}

// One sentence (or two) saying what happened, for anywhere that shows a line of text.
// `fallback` (optional, already in words: "Couldn't save the region.") stands in for an
// error thrown on this device and for a refusal the server gave no reason for; without one,
// a device error's own message shows (they're written for people: t(), codedError).
export function errorText(err, fallback) {
  const kind = typeof err === 'string' ? 'device' : errorKind(err);
  switch (kind) {
    case 'offline':
    case 'timeout':
      return t(`errors.text.${kind}`);
    case 'session': {
      // Logging in answers 401 with its reason ("Wrong two-factor code"); a request whose
      // login is gone gets the server's technical one, which means: logged out.
      const text = serverText(err);
      return text && !/authorization header/i.test(text) ? text : t('errors.text.session');
    }
    case 'server':
      // A 503 of ours explains itself; other 5xx are bugs, so their text means nothing.
      return (err?.response?.status === 503 && serverText(err)) || t('errors.text.server');
    case 'forbidden':
    case 'gone':
    case 'rate':
    case 'rejected':
      return serverText(err) || fallback || t(`errors.text.${kind}`);
    default: {
      if (fallback) return fallback;
      const message = typeof err === 'string' ? err : err?.message;
      return message || t('errors.text.unknown');
    }
  }
}

// Status, request and time, for bug reports (an error state's Details).
export function errorDetail(err, now = Date.now()) {
  const parts = [];
  const kind = errorKind(err);
  if (fromRequest(err)) {
    parts.push(err.response?.status ? String(err.response.status) : (err.code || kind));
    const method = (err.config?.method ?? 'get').toUpperCase();
    const url = (err.config?.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    if (url) parts.push(`${method} ${url.startsWith('/') ? url : `/${url}`}`);
  } else {
    parts.push(err?.name && err.name !== 'Error' ? err.name : kind);
  }
  parts.push(formatDateTime(now, { seconds: true }));
  return parts.join(' · ');
}

// Everything an error component needs. `err` may also be a string (an error already in words).
export function describeError(err, now = Date.now()) {
  const kind = typeof err === 'string' ? 'device' : errorKind(err);
  return {
    kind,
    text: errorText(err),
    retryable: RETRYABLE.has(kind),
    detail: typeof err === 'string' ? null : errorDetail(err, now),
    code: err?.response?.data?.code ?? err?.code ?? null,
  };
}

// An error in words with a code an error component can act on: 'no_keys' (this device has no
// encryption keys: Log out and back in), 'offline_not_saved' (offline, and this chat isn't
// in the offline copy).
export function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}
