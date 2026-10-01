// A poll is a message whose whole text is `poll:v1:` + JSON:
//   { "q": question, "multi": false, "o": [{ "id": "k3j2h4g5", "t": "Answer", "e": "🍕" }, ...] }
// (`e`, optional: the answer's emoji, Unicode or a custom `<:name:id>`), plus `d`: how long it
// runs, in seconds from the message's (server) timestamp, and `x` once its author ends it early
// (unix s). Polls from before durations have no `d` and never end.
// so in DMs and group DMs it's inside the encryption like any message. Votes are reactions
// whose "emoji" is `poll:<option id>` (VOTE_PREFIX): stored, encrypted (DMs, groups), signed
// (groups) and delivered exactly like reactions, so the server can't tell a vote from a
// reaction in encrypted chats. Reaction chips leave them out (utils/reactions.js).
//
// Editing a poll gives every option whose text or emoji changed a new id, so the votes it had stop
// counting (they point at an id that's gone). Voting clears your own such leftovers.

export const POLL_PREFIX = 'poll:v1:';
export const VOTE_PREFIX = 'poll:';
export const MAX_POLL_OPTIONS = 10;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_OPTION_LENGTH = 55;

// How long a poll can run (Discord's choices); 24 hours unless picked.
export const POLL_DURATIONS = [
  { label: '1 hour', seconds: 3600 },
  { label: '4 hours', seconds: 4 * 3600 },
  { label: '8 hours', seconds: 8 * 3600 },
  { label: '24 hours', seconds: 24 * 3600 },
  { label: '3 days', seconds: 3 * 86400 },
  { label: '1 week', seconds: 7 * 86400 },
  { label: '2 weeks', seconds: 14 * 86400 },
];
export const DEFAULT_POLL_DURATION = 24 * 3600;
const MAX_POLL_DURATION = 14 * 86400;

const OPTION_ID = /^[a-z0-9]{8}$/;
const MAX_EMOJI_LENGTH = 64;

// An answer's emoji if it looks like one (a short string without spaces), else null.
function cleanEmoji(emoji) {
  return typeof emoji === 'string' && emoji && emoji.length <= MAX_EMOJI_LENGTH && !/\s/.test(emoji) ? emoji : null;
}
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newOptionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

// { question, multi, duration, endedAt?, options: [{ id, text, emoji? }] } -> message text.
export function pollMarkup({ question, multi, duration, endedAt, options }) {
  return POLL_PREFIX + JSON.stringify({
    q: question,
    multi: Boolean(multi),
    ...(duration ? { d: duration } : {}),
    ...(endedAt ? { x: endedAt } : {}),
    o: options.map((o) => (o.emoji ? { id: o.id, t: o.text, e: o.emoji } : { id: o.id, t: o.text })),
  });
}

const positiveInt = (n, max = Infinity) => (Number.isInteger(n) && n > 0 && n <= max ? n : null);

// The poll in a message's text, or null when it isn't one (or is malformed).
export function parsePoll(text) {
  if (typeof text !== 'string' || !text.startsWith(POLL_PREFIX)) return null;
  let data;
  try {
    data = JSON.parse(text.slice(POLL_PREFIX.length));
  } catch {
    return null;
  }
  if (!data || typeof data.q !== 'string' || !data.q.trim() || !Array.isArray(data.o)) return null;
  const ids = new Set();
  const options = [];
  for (const o of data.o.slice(0, MAX_POLL_OPTIONS)) {
    if (!o || !OPTION_ID.test(o.id) || typeof o.t !== 'string' || !o.t.trim() || ids.has(o.id)) return null;
    ids.add(o.id);
    options.push({ id: o.id, text: o.t.slice(0, MAX_OPTION_LENGTH), emoji: cleanEmoji(o.e) });
  }
  if (options.length === 0) return null;
  return {
    question: data.q.slice(0, MAX_QUESTION_LENGTH),
    multi: data.multi === true,
    duration: positiveInt(data.d, MAX_POLL_DURATION),
    endedAt: positiveInt(data.x),
    options,
  };
}

// When a poll sent at `sentAt` (unix s, the message's timestamp) closes (unix s), or null if
// it never does: its duration, or earlier if its author ended it.
export function pollEndsAt(poll, sentAt) {
  const byDuration = poll.duration && sentAt ? sentAt + poll.duration : null;
  if (byDuration && poll.endedAt) return Math.min(byDuration, poll.endedAt);
  return byDuration ?? poll.endedAt ?? null;
}

// Ended early by its author counts at once, whatever this device's clock says.
export function pollEnded(poll, sentAt, now = Date.now() / 1000) {
  if (poll.endedAt) return true;
  const endsAt = pollEndsAt(poll, sentAt);
  return endsAt != null && now >= endsAt;
}

// The poll ended by its author now.
export function endPoll(poll, now = Math.floor(Date.now() / 1000)) {
  return { ...poll, endedAt: now };
}

// "3 days left", "5 hours left", "12 minutes left", "less than a minute left".
export function timeLeft(seconds) {
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} left`;
  if (seconds >= 86400) return plural(Math.floor(seconds / 86400), 'day');
  if (seconds >= 3600) return plural(Math.floor(seconds / 3600), 'hour');
  if (seconds >= 60) return plural(Math.floor(seconds / 60), 'minute');
  return 'less than a minute left';
}

// Whether an answer of `poll` was changed (text or emoji) in `option` ({ id, text, emoji }).
export function optionChanged(poll, option) {
  const old = poll.options.find((o) => o.id === option.id);
  return !old || old.text !== option.text || (old.emoji ?? null) !== (option.emoji ?? null);
}

// The poll after an edit: options keep their id only if their text and emoji are unchanged
// (so votes on an edited option are dropped); new ones get a new id. `multi`, the duration
// and an early end can't change.
export function editedPoll(original, { question, options }) {
  return {
    question,
    multi: original.multi,
    duration: original.duration,
    endedAt: original.endedAt,
    options: options.map((o) => ({
      id: o.id && !optionChanged(original, o) ? o.id : newOptionId(),
      text: o.text,
      emoji: o.emoji ?? null,
    })),
  };
}

// For plain-text places (reply previews, notifications, copying).
export function pollSummary(poll) {
  return `📊 Poll: ${poll.question}`;
}

export const voteKey = (optionId) => VOTE_PREFIX + optionId;
export const isVote = (emoji) => typeof emoji === 'string' && emoji.startsWith(VOTE_PREFIX);
export const voteOption = (emoji) => (isVote(emoji) ? emoji.slice(VOTE_PREFIX.length) : null);

// Who voted for what: { voters: { optionId: [userId] }, total (people who voted), cast (votes
// cast: in a multiple-choice poll one person can cast several, so shares are of this) }. Votes for
// options that no longer exist don't count. In a single-choice poll only each person's latest
// vote counts (two devices could race). With `endsAt` (unix s, see pollEndsAt), votes the
// server timestamped after the poll closed don't count either (one without a timestamp, just
// made on this device, does).
export function tallyVotes(poll, reactions, endsAt = null) {
  const voters = Object.fromEntries(poll.options.map((o) => [o.id, []]));
  const votes = (reactions ?? []).filter((r) =>
    voters[voteOption(r.emoji)] && (endsAt == null || r.timestamp == null || r.timestamp <= endsAt)
  );
  const counted = poll.multi
    ? votes
    : [...new Map(votes.map((r) => [r.user_id, r])).values()];
  const people = new Set();
  for (const r of counted) {
    const list = voters[voteOption(r.emoji)];
    if (!list.includes(r.user_id)) list.push(r.user_id);
    people.add(r.user_id);
  }
  const cast = Object.values(voters).reduce((sum, list) => sum + list.length, 0);
  return { voters, total: people.size, cast };
}

// An answer's share of the votes cast, as a rounded percentage.
export const voteShare = (count, cast) => (cast ? Math.round((count / cast) * 100) : 0);

// What voting for exactly `optionIds` (your whole choice; [] takes your vote back) does with
// `userId`'s votes: { remove: [reaction], add: [optionId] }. Votes for answers that no longer
// exist are cleared too.
export function planVotes(poll, reactions, userId, optionIds) {
  const live = new Set(poll.options.map((o) => o.id));
  const wanted = new Set(optionIds.filter((id) => live.has(id)).slice(0, poll.multi ? undefined : 1));
  const mine = (reactions ?? []).filter((r) => r.user_id === userId && isVote(r.emoji));
  const kept = new Set();
  const remove = [];
  for (const r of mine) {
    const option = voteOption(r.emoji);
    if (wanted.has(option) && !kept.has(option)) kept.add(option);
    else remove.push(r);
  }
  return { remove, add: [...wanted].filter((id) => !kept.has(id)) };
}

// The answers `userId` currently has votes on (as tallyVotes counts them).
export function myVotes(poll, reactions, userId, endsAt = null) {
  const { voters } = tallyVotes(poll, reactions, endsAt);
  return poll.options.filter((o) => voters[o.id].includes(userId)).map((o) => o.id);
}

// A closed poll's result, for its "poll ended" row: { cast (votes cast), winners ([option];
// several in a draw, none if nobody voted), votes (each winner's), share (% of the votes cast,
// rounded) }.
export function pollResult(poll, reactions, endsAt = null) {
  const { voters, cast } = tallyVotes(poll, reactions, endsAt);
  const most = Math.max(0, ...poll.options.map((o) => voters[o.id].length));
  const winners = most > 0 ? poll.options.filter((o) => voters[o.id].length === most) : [];
  return { cast, winners, votes: most, share: voteShare(most, cast) };
}

// Whether a "poll ended" row posted at `postedAt` fits its poll (sent at `sentAt`): its author
// ended it, or its time was up by then (give or take a minute). The server posts these rows,
// so in an encrypted chat one for a poll that says it's still running isn't shown.
export function pollEndFits(poll, sentAt, postedAt) {
  if (poll.endedAt) return true;
  return Boolean(poll.duration && sentAt && sentAt + poll.duration <= postedAt + 60);
}
