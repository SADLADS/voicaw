// What people are doing (Rich Presence: "Playing Hades", a bot's "Watching 3 guilds"), from
// the server (server/activities.js): a snapshot each time this device (re)connects, then
// changes (`user_activities`). Only the desktop app shares any (electron/richPresence.js);
// every app shows them.
// One activity: { name, type, details, state, start, end, partySize, partyMax, imageText, image }
// (`name` null: a game nobody could name; `type` Discord's; start/end unix ms; `image` an id).

import { faGamepad, faMusic, faTowerBroadcast, faTrophy, faTv } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';
import { apiBaseUrl } from './server';

const EMPTY = [];
const byUser = new Map(); // user id (string) -> activities
let version = 0;
const listeners = new Set();

function changed() {
  version += 1;
  listeners.forEach((cb) => cb());
}

export function applyActivitiesSnapshot(snapshot) {
  byUser.clear();
  for (const [userId, list] of Object.entries(snapshot ?? {})) {
    if (Array.isArray(list) && list.length) byUser.set(String(userId), list);
  }
  changed();
}

export function applyUserActivities({ userId, activities }) {
  const id = String(userId);
  if (Array.isArray(activities) && activities.length) byUser.set(id, activities);
  else byUser.delete(id);
  changed();
}

// On logout.
export function resetActivities() {
  byUser.clear();
  changed();
}

export function subscribeActivities(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getActivitiesVersion() {
  return version;
}

export function activitiesOf(userId) {
  return byUser.get(String(userId)) ?? EMPTY;
}

// The picture's address (served by the API, no login needed).
export function activityImageUrl(id, apiBase = apiBaseUrl()) {
  if (!id) return null;
  const base = new URL(apiBase.endsWith('/') ? apiBase : `${apiBase}/`, window.location.href);
  return new URL(`activity-images/${id}`, base).href;
}

const VERBS = { 0: 'activities.playing', 1: 'activities.streaming', 2: 'activities.listening', 3: 'activities.watching', 5: 'activities.competing' };

// The activity's name: a game's, or "a game".
export const activityName = (activity) => activity.name || t('activities.unknownGame');

// The i18n key for one line about it ("Playing {{name}}"), or null for a bot's custom status
// (which is just its text).
export const activityLineKey = (activity) => (activity.type === 4 ? null : VERBS[activity.type] ?? VERBS[0]);

// The icon for its kind: a gamepad for Playing, a note for Listening, a TV for Watching, a
// broadcast tower for Streaming, a trophy for Competing; none for a bot's custom status.
const ICONS = { 0: faGamepad, 1: faTowerBroadcast, 2: faMusic, 3: faTv, 5: faTrophy };
export const activityIcon = (activity) => (activity.type === 4 ? null : ICONS[activity.type] ?? faGamepad);

// The profile card's heading: "Playing a game", "Watching", ...
const HEADINGS = { 1: 'activities.headingStreaming', 2: 'activities.headingListening', 3: 'activities.headingWatching', 5: 'activities.headingCompeting' };
export const activityHeading = (activity) => t(HEADINGS[activity.type] ?? 'activities.headingPlaying');

// "1:02:03", "4:05" for a length of time.
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// "12:34 elapsed" / "3:00 left" (as Discord), or null without times.
export function activityTime(activity, now = Date.now()) {
  if (activity.end && activity.end > now) return t('activities.left', { time: clock(activity.end - now) });
  if (activity.start && activity.start <= now) return t('activities.elapsed', { time: clock(now - activity.start) });
  return null;
}

// "(2 of 4)".
export function activityParty(activity) {
  if (activity.partyMax == null || !activity.partyMax) return null;
  return t('activities.party', { size: activity.partySize, max: activity.partyMax });
}
