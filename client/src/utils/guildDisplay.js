import { nameOf } from './profiles';
import { isAndroidApp } from './android';
import { apiBaseUrl, isBuiltInServer } from './server';
import { t } from '../i18n';

// "Test Guild" -> "TG", "voicaw" -> "v": what a guild without an icon shows (like Discord).
export function guildInitials(name) {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => [...word][0])
    .join('')
    .slice(0, 3);
}

// Its channels grouped for the sidebar: first those without a category, then each category
// with its channels, all in order.
export function groupChannels(guild) {
  const channels = [...(guild?.channels ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const categories = [...(guild?.categories ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  return {
    uncategorized: channels.filter((c) => c.category_id == null || !categories.some((cat) => cat.id === c.category_id)),
    categories: categories.map((category) => ({
      ...category,
      channels: channels.filter((c) => c.category_id === category.id),
    })),
  };
}

// The channel a guild opens on: the last one viewed there (on this device) if it still
// exists, otherwise the first text channel (then the first list channel).
export function defaultChannel(guild) {
  let remembered = null;
  try {
    remembered = localStorage.getItem(`guildChannel:${guild.id}`);
  } catch {
    // Storage unavailable.
  }
  const { uncategorized, categories } = groupChannels(guild);
  const ordered = [...uncategorized, ...categories.flatMap((c) => c.channels)];
  return ordered.find((c) => String(c.id) === remembered)
    ?? ordered.find((c) => c.type === 'text')
    ?? ordered.find((c) => c.type === 'list' || c.type === 'doc')
    ?? ordered[0]
    ?? null;
}

export function rememberChannel(guildId, channelId) {
  try {
    localStorage.setItem(`guildChannel:${guildId}`, String(channelId));
  } catch {
    // Storage unavailable.
  }
}

// Whether this is the web app in a browser, whose own address can be shared (not the desktop
// app's voicaw://app or the Android app's https://localhost, which only open inside them).
const pageLocation = () => globalThis.window?.location;
const inBrowser = () => /^https?:$/.test(pageLocation()?.protocol ?? '') && !isAndroidApp();

// Where links to share point: this site in a browser, else the web app of the server the app
// uses, which is where its API lives (app.voicaw.com for the built-in one).
export function shareOrigin() {
  if (inBrowser()) return pageLocation().origin;
  try {
    return new URL(apiBaseUrl(), pageLocation()?.href).origin;
  } catch {
    return 'https://app.voicaw.com';
  }
}

// Whether a link's origin is this app's: the one it shares links from, and app.voicaw.com
// while on the built-in server (its links still open from a test copy or the dev server).
function isAppOrigin(origin) {
  return origin === shareOrigin() || (isBuiltInServer() && origin === 'https://app.voicaw.com');
}

// The app's pages a link can open in place (App.jsx's routes for someone logged in).
const APP_PATH = /^\/(?:guild\/\d+(?:\/\d+)?|invite\/[A-Za-z0-9-]+|dm(?:\/[^/]+){0,2}|settings(?:\/[^/]+)*|developers(?:\/applications\/\d+)?)\/?$/;

// The path, query and fragment of a link to one of this app's own pages ("https://app.voicaw.com/
// guild/12?event=34" -> "/guild/12?event=34"), which the app opens in place rather than in a
// browser, else null.
export function appPathOf(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isAppOrigin(url.origin) || !APP_PATH.test(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

// The link to share for an invite code.
export function inviteLink(code) {
  return `${shareOrigin()}/invite/${code}`;
}

// The link to a guild (Copy Link in its menu on the rail).
export function guildLink(guildId) {
  return `${shareOrigin()}/guild/${guildId}`;
}

// The link to a guild channel (Copy Link in the channel menu).
export function channelLink(guildId, channelId) {
  return `${shareOrigin()}/guild/${guildId}/${channelId}`;
}

// The link to a scheduled event (Copy Link on it; opens it over its guild), with `on` (a date,
// 'YYYY-MM-DD') one occurrence of a repeating one; without, the series (its next occurrence).
export function eventLink(guildId, eventId, on = null) {
  return `${shareOrigin()}/guild/${guildId}?event=${eventId}${on ? `&on=${on}` : ''}`;
}

// The guild and channel in a channel link (channelLink: this site's or app.voicaw.com's), else
// null.
export function parseChannelLink(href) {
  const match = /^(https?:\/\/[^/]+)\/guild\/(\d+)\/(\d+)\/?$/.exec(href ?? '');
  if (!match || !isAppOrigin(match[1])) return null;
  return { guildId: match[2], channelId: match[3] };
}

// The invite code in something pasted: a whole link or just the code.
export function parseInviteCode(text) {
  const trimmed = (text ?? '').trim();
  const match = /\/invite\/([A-Za-z0-9-]+)\/?$/.exec(trimmed);
  if (match) return match[1];
  return /^[A-Za-z0-9-]+$/.test(trimmed) ? trimmed : null;
}

// What to tell the user about a failed request: the server's message if it sent one.
export function errorMessage(err) {
  return err?.response?.data?.error || err?.message || t('guilds.somethingWentWrong');
}

// Online members grouped like Discord: under their highest "display separately" (hoisted)
// role, the rest under Online; everyone offline under Offline. Each group sorted by name.
// `status` is the member's online status (utils/presence.js); idle and mobile count as online.
export function groupMembers(members, roles) {
  const hoisted = (roles ?? []).filter((r) => !r.is_everyone && r.hoist);
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
  const groups = hoisted.map((role) => ({ key: `role-${role.id}`, title: role.name, members: [] }));
  const online = { key: 'online', title: t('guilds.memberList.online'), members: [] };
  const offline = { key: 'offline', title: t('guilds.memberList.offline'), members: [] };
  for (const member of members) {
    if ((member.status ?? 'offline') === 'offline') {
      offline.members.push(member);
      continue;
    }
    const ids = new Set(member.role_ids ?? []);
    const index = hoisted.findIndex((r) => ids.has(r.id)); // highest first
    (index === -1 ? online : groups[index]).members.push(member);
  }
  return [...groups, online, offline]
    .filter((g) => g.members.length > 0)
    .map((g) => ({ ...g, members: g.members.sort(byName) }));
}

// "party blob (1).gif" -> "party_blob_1": what an uploaded file is called at first.
export function emojiNameFromFile(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return base.length >= 2 ? base : `emoji_${base}`.slice(0, 32);
}
