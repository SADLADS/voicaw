// Where a guild message sits in its channel: by time, then id (server/routes/guildMessages.js).
// Live messages' ids and times grow together, but imported ones (history imports, see
// docs/guilds.md) have old times and new ids, so an id alone doesn't say what came first.
// Negative when `a` is older than `b`.
export function comparePosition(a, b) {
  return (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id - b.id;
}

// The highest id among `rows` (what marking read takes: every live message newer than any of
// them has a higher id), or null.
export function highestId(rows) {
  let max = null;
  for (const row of rows) if (Number.isInteger(row.id) && (max == null || row.id > max)) max = row.id;
  return max;
}
