// For searching DMs and group DMs on the device (Search in docs/messages.md): the device keeps
// its own encrypted copy of a conversation in id ranges, and asks how many messages each range
// holds now and when one was last edited, to find ranges where something was deleted or
// edited since (and read those again). Only ids and times: nothing the server doesn't know,
// and never which messages a search found.

const MAX_RANGES = 2000;

// `body.ranges` ([[from, to], ...], ids inclusive, ascending, not overlapping) -> the ranges,
// or null if invalid.
function parseRanges(body) {
  const ranges = body?.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_RANGES) return null;
  let previous = -Infinity;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    const [from, to] = range;
    if (from > to || from <= previous) return null;
    previous = to;
  }
  return ranges;
}

// `rows` ([{ id, edited_at }], ascending by id), the conversation's messages from the first
// range's start to the last one's end -> [{ rows, edited }] per range (`edited`: the latest
// edited_at in it, 0 if none).
function countRanges(rows, ranges) {
  const out = ranges.map(() => ({ rows: 0, edited: 0 }));
  let r = 0;
  for (const { id, edited_at: editedAt } of rows) {
    while (r < ranges.length && id > ranges[r][1]) r += 1;
    if (r === ranges.length) break;
    if (id < ranges[r][0]) continue;
    out[r].rows += 1;
    out[r].edited = Math.max(out[r].edited, Number(editedAt) || 0);
  }
  return out;
}

module.exports = { parseRanges, countRanges, MAX_RANGES };
