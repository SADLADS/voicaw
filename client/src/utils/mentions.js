import { nameOf } from './profiles';

// Mentions, written like Discord's in message text: `<@id>` (a person), `<@&id>` (a guild role),
// and `@everyone` / `@here` (in a guild, everyone who can see the channel / those of them
// online; only with Mention Everyone, else plain text). Only ids are stored, so a name is
// always the current one, looked up when drawn: `names` ({ id: username }) for people, `roles`
// ({ id: { name, color } }) for roles. Who a guild message actually pinged is the server's call
// (message.mention_everyone, mention_roles; see server/mentions.js).

// Fresh global regexes each call (they're stateful).
export const mentionPattern = () => /<@(\d+)>/g;
export const roleMentionPattern = () => /<@&(\d+)>/g;

export const mentionText = (id) => `<@${id}>`;
export const roleMentionText = (id) => `<@&${id}>`;

// Someone who isn't in the chat (any more), a role that's gone.
export const UNKNOWN_MENTION = 'unknown-user';
export const UNKNOWN_ROLE = 'deleted-role';

export function mentionName(names, id) {
  return names?.[id] ?? UNKNOWN_MENTION;
}

export function roleName(roles, id) {
  return roles?.[id]?.name ?? UNKNOWN_ROLE;
}

// For plain-text places (reply previews, notifications, copying): `<@id>` → `@name`,
// `<@&id>` → `@role`.
export function mentionsToText(text, names, roles) {
  if (text == null) return text;
  return String(text)
    .replace(roleMentionPattern(), (_, id) => `@${roleName(roles, id)}`)
    .replace(mentionPattern(), (_, id) => `@${mentionName(names, id)}`);
}

// Whether the text mentions user `id` by name.
export function mentionsUser(text, id) {
  if (text == null || id == null) return false;
  for (const m of String(text).matchAll(mentionPattern())) {
    if (m[1] === String(id)) return true;
  }
  return false;
}

// Whether a message is for you: it names you, pinged @everyone/@here, or one of your roles.
export function mentionsMe(msg, meId, myRoleIds) {
  if (mentionsUser(msg.plaintext, meId)) return true;
  if (msg.mention_everyone) return true;
  const mine = new Set((myRoleIds ?? []).map(Number));
  return (msg.mention_roles ?? []).some((id) => mine.has(Number(id)));
}

const rank = (name, q) => {
  const lower = name.toLowerCase();
  return lower.startsWith(q) ? 0 : lower.includes(q) ? 1 : -1;
};

const byRankThenName = (a, b) => a[0] - b[0] || a[1].localeCompare(b[1], undefined, { sensitivity: 'base' });

// People ([{ id, username }]) matching what's been typed after "@" in their display name or
// username, best first: starting with it, then containing it; alphabetical (by the name shown)
// within each. An empty query gives everyone.
export function searchPeople(people, query, limit = 8) {
  const q = query.toLowerCase();
  const bestRank = (a, b) => (a < 0 ? b : b < 0 ? a : Math.min(a, b));
  return people
    .map((p) => [bestRank(rank(nameOf(p), q), rank(p.username, q)), nameOf(p), p])
    .filter(([r]) => r >= 0)
    .sort(byRankThenName)
    .slice(0, limit)
    .map(([, , p]) => p);
}

const EVERYONE_ITEMS = [
  { kind: 'everyone', name: 'everyone', description: 'Notify everyone who can see this channel.' },
  { kind: 'everyone', name: 'here', description: 'Notify everyone online who can see this channel.' },
];

// What "@query" could complete to, like Discord's list: people first, then roles
// ([{ id, name, color }]), then @everyone and @here (with `everyone` true). Each item is
// { kind: 'user', id, name } | { kind: 'role', id, name, color } | { kind: 'everyone', name, description }.
export function searchMentions({ people = [], roles = [], everyone = false }, query, limit = 10) {
  const q = query.toLowerCase();
  const users = searchPeople(people, query, limit).map((p) => ({ kind: 'user', id: p.id, name: nameOf(p), username: p.username }));
  const matchingRoles = roles
    .map((r) => [rank(r.name, q), r.name, r])
    .filter(([r]) => r >= 0)
    .sort(byRankThenName)
    .map(([, , r]) => ({ kind: 'role', id: r.id, name: r.name, color: r.color ?? null }));
  const mass = everyone ? EVERYONE_ITEMS.filter((item) => rank(item.name, q) >= 0) : [];
  // Keep room for the roles and @everyone/@here when there are many people.
  const others = [...matchingRoles.slice(0, 3), ...mass];
  return [...users.slice(0, Math.max(limit - others.length, 5)), ...others].slice(0, limit);
}
