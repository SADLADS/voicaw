import { apiBaseUrl } from './server';

// A webhook's URL, as people paste it into other apps: the app's API address (the same one this
// app uses, e.g. https://voicaw.com/api/) + webhooks/<id>/<token>, like Discord's.
export function webhookUrl(hook, apiBase = apiBaseUrl()) {
  const base = new URL(apiBase.endsWith('/') ? apiBase : `${apiBase}/`, window.location.href);
  return new URL(`webhooks/${hook.id}/${hook.token}`, base).href;
}
