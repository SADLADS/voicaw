import { desktop } from '../utils/desktop';
import { android } from '../utils/android';
import { drawnByApp, linksIn, mediaLinkKind } from '../utils/linkPreviews';
import { embedFromResponse } from '../utils/pageEmbed';
import { getPrivacyPrefs } from '../utils/privacy';

// Link previews for a message this device sends in an end-to-end encrypted chat (see Link
// previews in docs/messages.md). A web page can't read other sites' pages, and asking our server
// would tell it the link, so only the desktop and Android apps make them: their native side
// fetches the page (electron/pageFetch.js, PageFetch.java: public addresses only, a page's first
// 1 MB, 5 seconds), and pageEmbed.js reads its card as the server does for guilds. Links the app
// already draws (YouTube, invites, links straight to a picture or a video) are left out, and
// nothing is fetched with Settings → Privacy's "Show link previews" off.

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 200;
const cache = new Map(); // link -> { embed, expires }

// { status, url, contentType, html } from the app's native side, or null.
function fetchPage(url) {
  if (desktop?.fetchPage) return desktop.fetchPage(url);
  if (android) return android.fetchPage({ url });
  return null;
}

export const canMakePreviews = () => Boolean(desktop?.fetchPage || android);

async function previewFor(link) {
  const cached = cache.get(link);
  if (cached && cached.expires > Date.now()) return cached.embed;
  let embed = null;
  try {
    embed = embedFromResponse(await fetchPage(link), link);
  } catch (err) {
    console.warn('Link preview failed', err?.message);
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(link, { embed, expires: Date.now() + CACHE_TTL_MS });
  return embed;
}

// -> the embeds for the links in `text` that get one (maybe none).
export async function previewsFor(text) {
  if (!canMakePreviews() || !getPrivacyPrefs().showLinkPreviews) return [];
  const links = linksIn(text).filter((link) => !drawnByApp(link) && !mediaLinkKind(link));
  return (await Promise.all(links.map(previewFor))).filter(Boolean);
}
