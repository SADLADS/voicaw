// The search box's language, Discord's: words, `"exact phrases"`, and filters
// `from:user`, `mentions:user`, `in:channel`, `has:thing` (a value with spaces in quotes).
// parseSearch turns it into the server's parameters (routes/guildSearch.js; the device's own
// search of encrypted chats takes the same, services/searchIndex.js), with people and
// channels as ids; searchSuggestions says what to offer while typing. `keys` (the filters
// there are; DMs have no `in:`) and `hasValues` default to a guild's.

import { t } from '../i18n';

export const SEARCH_KEYS = ['from', 'mentions', 'in', 'has'];

export const HAS_VALUES = ['link', 'embed', 'file', 'image', 'video', 'sound', 'poll', 'forward'];

const filterRe = (keys) => new RegExp(`(^|\\s)(${keys.join('|')}):("[^"]*"?|\\S*)`, 'gi');

const unquote = (value) => value.replace(/^"/, '').replace(/"$/, '');

// How a value is written in the box (quoted if it has spaces or quotes).
export function quoteValue(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

const lower = (s) => String(s ?? '').toLocaleLowerCase();

// The member called `name`: by username, else by display name if only one has it.
function findMember(name, members) {
  const wanted = lower(name);
  const byUsername = members.find((m) => lower(m.username) === wanted);
  if (byUsername) return byUsername;
  const byDisplay = members.filter((m) => m.display_name && lower(m.display_name) === wanted);
  return byDisplay.length === 1 ? byDisplay[0] : null;
}

// `query` → { params (for the API), problems ([text]), empty (nothing to search for) }.
// `members` [{ id, username, display_name }], `channels` the text channels [{ id, name }].
export function parseSearch(query, { members = [], channels = [], keys = SEARCH_KEYS, hasValues = HAS_VALUES } = {}) {
  const params = { content: '', author_id: [], mentions: [], channel_id: [], has: [] };
  const problems = [];
  const content = String(query ?? '').replace(filterRe(keys), (all, space, rawKey, rawValue) => {
    const key = rawKey.toLowerCase();
    const value = unquote(rawValue).trim();
    if (!value) return space;
    if (key === 'from' || key === 'mentions') {
      const member = findMember(value.replace(/^@/, ''), members);
      if (member) params[key === 'from' ? 'author_id' : 'mentions'].push(member.id);
      else problems.push(t('guilds.search.noMember', { name: value }));
    } else if (key === 'in') {
      const channel = channels.find((c) => lower(c.name) === lower(value.replace(/^#/, '')));
      if (channel) params.channel_id.push(channel.id);
      else problems.push(t('guilds.search.noChannel', { name: value.replace(/^#/, '') }));
    } else if (hasValues.includes(lower(value))) {
      params.has.push(lower(value));
    } else {
      problems.push(t('guilds.search.hasValues', { values: hasValues.join(', ') }));
    }
    return space;
  });
  params.content = content.replace(/\s+/g, ' ').trim();
  for (const key of Object.keys(params)) {
    if (Array.isArray(params[key])) params[key] = [...new Set(params[key])];
  }
  const empty = !params.content && SEARCH_KEYS.every((k) => !params[k === 'from' ? 'author_id' : k === 'in' ? 'channel_id' : k].length);
  return { params, problems, empty };
}

// What to suggest for the word the caret is at the end of: { kind: 'keys', prefix } (the
// filters, for an empty box or a word that starts one), { kind: 'from' | 'mentions' | 'in' |
// 'has', value } (values for that filter), or null. `start` is where that word begins.
export function searchContext(text, caret = text.length, keys = SEARCH_KEYS) {
  const before = text.slice(0, caret);
  const start = before.search(/\S*$/);
  const word = before.slice(start);
  const filter = word.match(new RegExp(`^(${keys.join('|')}):(.*)$`, 'i'));
  if (filter) return { kind: filter[1].toLowerCase(), value: unquote(filter[2]), start };
  if (!word.trim()) return before.trim() ? null : { kind: 'keys', prefix: '', start };
  const prefix = word.toLowerCase();
  return keys.some((k) => k.startsWith(prefix)) ? { kind: 'keys', prefix, start } : null;
}

const MAX_SUGGESTIONS = 8;

// The suggestions for `context` (searchContext): [{ kind, key?, value, label, ...item }], where
// picking one writes `insert` at `context.start` up to the caret.
export function searchSuggestions(context, { members = [], channels = [], nameOf = (m) => m.username, keys = SEARCH_KEYS, hasValues = HAS_VALUES } = {}) {
  if (!context) return [];
  if (context.kind === 'keys') {
    return keys.filter((k) => k.startsWith(context.prefix))
      .map((key) => ({ kind: 'key', key, insert: `${key}:`, keepOpen: true }));
  }
  const value = lower(context.value).replace(/^[@#]/, '');
  const key = context.kind;
  if (key === 'has') {
    return hasValues.filter((v) => v.startsWith(value))
      .map((v) => ({ kind: 'has', key, label: v, insert: `has:${v} ` }));
  }
  if (key === 'in') {
    return channels.filter((c) => lower(c.name).includes(value)).slice(0, MAX_SUGGESTIONS)
      .map((c) => ({ kind: 'channel', key, id: c.id, label: c.name, insert: `in:${quoteValue(c.name)} ` }));
  }
  return members
    .filter((m) => lower(m.username).startsWith(value) || lower(nameOf(m)).startsWith(value))
    .slice(0, MAX_SUGGESTIONS)
    .map((m) => ({ kind: 'member', key, id: m.id, label: nameOf(m), username: m.username, insert: `${key}:${quoteValue(m.username)} ` }));
}
