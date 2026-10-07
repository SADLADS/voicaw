// Voicaw invite and event links in message text (for invite and event embeds).

// Where invite links come from: this app's own address, and voicaw.com's (the live site and
// test.voicaw.com share one API, so their invites work on each other).
function isVoicawHost(host) {
  return host === globalThis.location?.host || host === 'voicaw.com' || host.endsWith('.voicaw.com');
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

// The guild and event of an event link ("https://app.voicaw.com/guild/12?event=34", as
// eventLink makes them), or null.
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
  return guildId && /^\d+$/.test(eventId ?? '') ? { guildId: Number(guildId), eventId: Number(eventId) } : null;
}
