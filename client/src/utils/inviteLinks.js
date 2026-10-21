// Voicaw invite and event links in message text (for invite and event embeds).

import { isBuiltInServer } from './server';
import { shareOrigin } from './guildDisplay';

// Where invite links come from: the address this app shares links from (guildDisplay
// shareOrigin), and voicaw.com's (the live site and test.voicaw.com share one API, so their
// invites work on each other), unless this app uses another server (utils/server.js), where
// voicaw.com's codes mean nothing.
function isVoicawHost(host) {
  if (host === new URL(shareOrigin()).host) return true;
  return isBuiltInServer() && (host === 'voicaw.com' || host.endsWith('.voicaw.com'));
}

// The invite code of an invite link ("https://voicaw.com/invite/Ab3dEf7h"), or null.
export function inviteCodeFromUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !isVoicawHost(url.host)) return null;
  return /^\/invite\/([A-Za-z0-9-]{1,32})\/?$/.exec(url.pathname)?.[1] ?? null;
}

// Whether a link's `on` is a date ('YYYY-MM-DD').
export const isEventDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');

// The guild and event of an event link ("https://app.voicaw.com/guild/12?event=34", as
// eventLink makes them), and `on`, the date of a repeating one's occurrence ("&on=2026-10-27"),
// or null.
export function eventFromUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !isVoicawHost(url.host)) return null;
  const guildId = /^\/guild\/(\d+)(?:\/\d+)?\/?$/.exec(url.pathname)?.[1];
  const eventId = url.searchParams.get('event');
  if (!guildId || !/^\d+$/.test(eventId ?? '')) return null;
  const on = url.searchParams.get('on');
  return { guildId: Number(guildId), eventId: Number(eventId), ...(isEventDate(on) ? { on } : {}) };
}
