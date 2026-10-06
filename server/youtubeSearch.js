// YouTube search for Watch Together (watchParty.js `youtube.search`). The server asks YouTube,
// so YouTube sees Voicaw's server searching, not who searched. There's no API key to set up: it
// asks the endpoint youtube.com's own search page uses (InnerTube), which isn't a documented
// API and may change; if it does, searching fails (502) and pasting links still works.
//
// Results are { video_id, title, author, duration, live }: `duration` in seconds, null for a
// live stream. Upcoming premieres and streams (nothing to play yet) are left out. Each query's
// results are kept for CACHE_MS, so a group searching the same thing asks once.

const ENDPOINT = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const CLIENT = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'GB' };
const VIDEOS_ONLY = 'EgIQAQ=='; // the "Type: Video" filter
const MAX_RESULTS = 20;
const MAX_QUERY = 100;
const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED = 200;

const cache = new Map(); // normalised query -> { at, results }

const textOf = (field) => field?.simpleText ?? field?.runs?.map((run) => run.text).join('') ?? '';

// "1:02:03" -> 3723; null when it isn't a clock.
function secondsOf(clock) {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(clock)) return null;
  return clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// The videos in an InnerTube search answer, in YouTube's order.
function parseResults(data) {
  const results = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object' || results.length >= MAX_RESULTS) return;
    const video = node.videoRenderer;
    if (video) {
      const videoId = video.videoId;
      if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId) || seen.has(videoId) || video.upcomingEventData) return;
      const duration = secondsOf(textOf(video.lengthText));
      const live = duration == null || (video.badges ?? []).some((badge) => badge.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
      seen.add(videoId);
      results.push({
        video_id: videoId,
        title: textOf(video.title).slice(0, 200) || null,
        author: textOf(video.ownerText ?? video.longBylineText).slice(0, 100) || null,
        duration: live ? null : duration,
        live,
      });
      return;
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value);
  })(data);
  return results;
}

const normalise = (query) => query.trim().replace(/\s+/g, ' ').toLowerCase();

// Throws { status: 502 } when YouTube couldn't be asked or answered something unexpected.
async function search(query, { now = Date.now() } = {}) {
  const key = normalise(query).slice(0, MAX_QUERY);
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.results;
  const unavailable = () => Object.assign(new Error("YouTube couldn't be searched. Try again, or paste a link."), { status: 502 });
  let data;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: CLIENT }, query: query.trim().slice(0, MAX_QUERY), params: VIDEOS_ONLY }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw unavailable();
    data = await response.json();
  } catch {
    throw unavailable();
  }
  const results = parseResults(data);
  cache.delete(key);
  cache.set(key, { at: now, results });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return results;
}

module.exports = { MAX_QUERY, parseResults, secondsOf, search, cache };
