// The share screen's order (ShareDialog): the chats you last sent to first, newest first (GET
// /recent-chats: [{ kind: 'dm' | 'group' | 'channel', id, at }], a DM to yourself being your
// notes), then the rest in `destinations`' own order (hooks/useChatDestinations). Chats it
// lists that you can no longer send to (not in `destinations`) are left out.
export function orderByRecent(destinations, recents, myId) {
  const sentAt = new Map();
  for (const recent of recents ?? []) {
    const key = recent.kind === 'dm'
      ? (String(recent.id) === String(myId) ? 'notes' : `u-${recent.id}`)
      : recent.kind === 'group' ? `g-${recent.id}` : `c-${recent.id}`;
    if (!sentAt.has(key)) sentAt.set(key, recent.at ?? 0);
  }
  const recent = destinations.filter((d) => sentAt.has(d.key)).sort((a, b) => sentAt.get(b.key) - sentAt.get(a.key));
  return [...recent, ...destinations.filter((d) => !sentAt.has(d.key))];
}
