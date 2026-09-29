// Mentions of people, written `<@id>` in message text (like Discord), so a name is always
// the person's current one and a message can tell who it's about. What shows (`@name`) comes
// from the chat's members (`names`: { id: username }) when it's drawn.

// A fresh global regex each call (they're stateful).
export const mentionPattern = () => /<@(\d+)>/g;

export const mentionText = (id) => `<@${id}>`;

// Someone who isn't in the chat (any more).
export const UNKNOWN_MENTION = 'unknown-user';

export function mentionName(names, id) {
  return names?.[id] ?? UNKNOWN_MENTION;
}

// For plain-text places (reply previews, notifications, copying): `<@id>` → `@name`.
export function mentionsToText(text, names) {
  return text == null ? text : String(text).replace(mentionPattern(), (_, id) => `@${mentionName(names, id)}`);
}

// Whether the text mentions user `id`.
export function mentionsUser(text, id) {
  if (text == null || id == null) return false;
  for (const m of String(text).matchAll(mentionPattern())) {
    if (m[1] === String(id)) return true;
  }
  return false;
}

// People ([{ id, username }]) matching what's been typed after "@", best first: name starting
// with it, then containing it; alphabetical within each. An empty query gives everyone.
export function searchPeople(people, query, limit = 8) {
  const q = query.toLowerCase();
  const ranked = [];
  for (const person of people) {
    const name = person.username.toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
    if (rank >= 0) ranked.push([rank, person]);
  }
  return ranked
    .sort((a, b) => a[0] - b[0] || a[1].username.localeCompare(b[1].username, undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map(([, p]) => p);
}
