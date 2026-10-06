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
//
// An open poll (`open: true`) also takes answers from anyone: each is a reaction from whoever
// added it, `poll:+` + JSON { i: id, r: round, t: text } (ANSWER_PREFIX, text only), so who
// added it is the reaction's owner (signed in groups). `r` is the poll's round: changing the
// question starts a new one (and gives every answer a new id), so all added answers and votes
// stop counting. Its creator removes one by deleting their reaction; the poll's author by
// adding a reaction `poll:-<id>` (REMOVAL_PREFIX, only theirs count), since nobody can delete
// other people's reactions; in guilds the server removes them (anyone with Manage Messages
// too). pollWithAnswers is the poll with them: at most MAX_POLL_OPTIONS answers in all, none
// that repeats another ignoring case, none added after the poll closed.

import { t } from '../i18n';

export const POLL_PREFIX = 'poll:v1:';
export const VOTE_PREFIX = 'poll:';
export const ANSWER_PREFIX = 'poll:+';
export const REMOVAL_PREFIX = 'poll:-';
export const MAX_POLL_OPTIONS = 20;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_OPTION_LENGTH = 55;

// How long a poll can run (Discord's choices); 24 hours unless picked.
export const POLL_DURATIONS = [
  { label: t('chat.poll.duration.hours', { count: 1 }), seconds: 3600 },
  { label: t('chat.poll.duration.hours', { count: 4 }), seconds: 4 * 3600 },
  { label: t('chat.poll.duration.hours', { count: 8 }), seconds: 8 * 3600 },
  { label: t('chat.poll.duration.hours', { count: 24 }), seconds: 24 * 3600 },
  { label: t('chat.poll.duration.days', { count: 3 }), seconds: 3 * 86400 },
  { label: t('chat.poll.duration.weeks', { count: 1 }), seconds: 7 * 86400 },
  { label: t('chat.poll.duration.weeks', { count: 2 }), seconds: 14 * 86400 },
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

// { question, multi, open?, round?, duration, endedAt?, options: [{ id, text, emoji? }] } ->
// message text. An open poll needs its `round` (newOptionId).
export function pollMarkup({ question, multi, open, round, duration, endedAt, options }) {
  return POLL_PREFIX + JSON.stringify({
    q: question,
    multi: Boolean(multi),
    ...(open ? { open: true, r: round } : {}),
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
  const open = data.open === true && OPTION_ID.test(data.r);
  return {
    question: data.q.slice(0, MAX_QUESTION_LENGTH),
    multi: data.multi === true,
    open,
    round: open ? data.r : null,
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
  if (seconds >= 86400) return t('chat.poll.timeLeft.days', { count: Math.floor(seconds / 86400) });
  if (seconds >= 3600) return t('chat.poll.timeLeft.hours', { count: Math.floor(seconds / 3600) });
  if (seconds >= 60) return t('chat.poll.timeLeft.minutes', { count: Math.floor(seconds / 60) });
  return t('chat.poll.timeLeft.lessThanMinute');
}

// Whether an answer of `poll` was changed (text or emoji) in `option` ({ id, text, emoji }).
export function optionChanged(poll, option) {
  const old = poll.options.find((o) => o.id === option.id);
  return !old || old.text !== option.text || (old.emoji ?? null) !== (option.emoji ?? null);
}

// The poll after an edit: options keep their id only if their text and emoji are unchanged
// (so votes on an edited option are dropped); new ones get a new id. A new question drops
// every vote: all options get new ids, and an open poll a new round (so the answers people
// added are gone too). `multi`, `open`, the duration and an early end can't change.
export function editedPoll(original, { question, options }) {
  const newQuestion = question !== original.question;
  return {
    question,
    multi: original.multi,
    open: original.open,
    round: original.open ? (newQuestion ? newOptionId() : original.round) : null,
    duration: original.duration,
    endedAt: original.endedAt,
    options: options.map((o) => ({
      id: o.id && !newQuestion && !optionChanged(original, o) ? o.id : newOptionId(),
      text: o.text,
      emoji: o.emoji ?? null,
    })),
  };
}

// For plain-text places (reply previews, notifications, copying).
export function pollSummary(poll) {
  return t('chat.poll.summary', { question: poll.question });
}

export const voteKey = (optionId) => VOTE_PREFIX + optionId;
const VOTE = /^poll:[a-z0-9]{8}$/;
export const isVote = (emoji) => typeof emoji === 'string' && VOTE.test(emoji);
export const voteOption = (emoji) => (isVote(emoji) ? emoji.slice(VOTE_PREFIX.length) : null);
// Votes, added answers and removals: reactions that aren't shown as chips.
export const isPollReaction = (emoji) => typeof emoji === 'string' && emoji.startsWith(VOTE_PREFIX);

// An added answer's text as it's stored: one line, no control characters, trimmed.
export function cleanAnswer(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// For telling duplicates apart: answers differing only in case are the same.
const sameAnswer = (text) => cleanAnswer(text).toLowerCase();

// The reaction that adds answer `text` (cleaned) to round `round` as `id`.
export const answerKey = ({ id, round, text }) => ANSWER_PREFIX + JSON.stringify({ i: id, r: round, t: text });
export const removalKey = (optionId) => REMOVAL_PREFIX + optionId;

// { id, round, text } of an added answer's reaction, or null if it isn't one, or isn't exactly
// as the app makes them (anything else is ignored).
export function parseAnswer(emoji) {
  if (typeof emoji !== 'string' || !emoji.startsWith(ANSWER_PREFIX)) return null;
  let data;
  try {
    data = JSON.parse(emoji.slice(ANSWER_PREFIX.length));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 3) return null;
  const { i: id, r: round, t: text } = data;
  if (!OPTION_ID.test(id) || !OPTION_ID.test(round) || typeof text !== 'string') return null;
  if (!text || text.length > MAX_OPTION_LENGTH || cleanAnswer(text) !== text) return null;
  return { id, round, text };
}

const byTime = (a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity) || (a.id ?? 0) - (b.id ?? 0);

// The poll with the answers people added (an open poll; others as they are). Its options are
// the author's (`addedBy` null), then the added ones in the order the server got them, each
// with `addedBy` (who added it) and `reactionIds` (theirs, to delete). Added answers are left
// out when they're for another round, repeat an earlier answer (ignoring case) or id, were
// added after the poll closed (`endsAt`, see pollEndsAt), were removed by `authorId` (the poll's
// author), or come after MAX_POLL_OPTIONS.
export function pollWithAnswers(poll, reactions, authorId, endsAt = null) {
  if (!poll.open) return poll;
  const list = reactions ?? [];
  const removed = new Set(list
    .filter((r) => r.user_id === authorId && typeof r.emoji === 'string' && r.emoji.startsWith(REMOVAL_PREFIX))
    .map((r) => r.emoji.slice(REMOVAL_PREFIX.length)));
  const options = poll.options.map((o) => ({ ...o, addedBy: null }));
  const ids = new Set(options.map((o) => o.id));
  const texts = new Set(options.map((o) => sameAnswer(o.text)));
  const added = new Map();
  for (const r of [...list].sort(byTime)) {
    const answer = parseAnswer(r.emoji);
    if (!answer || answer.round !== poll.round) continue;
    if (endsAt != null && r.timestamp != null && r.timestamp > endsAt) continue;
    const same = added.get(answer.id);
    // The same answer twice (two devices racing) is one answer.
    if (same && same.addedBy === r.user_id && same.text === answer.text) {
      same.reactionIds.push(r.id);
      continue;
    }
    if (ids.has(answer.id) || texts.has(sameAnswer(answer.text))) continue;
    ids.add(answer.id);
    texts.add(sameAnswer(answer.text));
    if (removed.has(answer.id) || options.length >= MAX_POLL_OPTIONS) continue;
    const option = { id: answer.id, text: answer.text, emoji: null, addedBy: r.user_id, reactionIds: [r.id] };
    added.set(answer.id, option);
    options.push(option);
  }
  return { ...poll, options };
}

// Why answer `text` can't be added to `poll` (pollWithAnswers'), or null if it can.
export function answerProblem(poll, text) {
  const clean = cleanAnswer(text);
  if (!clean) return t('chat.poll.answerEmpty');
  if (clean.length > MAX_OPTION_LENGTH) return t('chat.poll.answerTooLong', { count: MAX_OPTION_LENGTH });
  if (poll.options.some((o) => sameAnswer(o.text) === sameAnswer(clean))) return t('chat.poll.answerDuplicate');
  if (poll.options.length >= MAX_POLL_OPTIONS) return t('chat.poll.answersFull', { count: MAX_POLL_OPTIONS });
  return null;
}

// Whether `userId` may remove the added answer `option` from `poll` (pollWithAnswers'): its
// creator, the poll's author (`authorId`) or, in a guild, a moderator (`canModerate`; not an
// answer the author added), and only while nobody but its creator and them has voted for it
// (`voters`, tallyVotes').
export function canRemoveAnswer(option, { userId, authorId, canModerate = false, voters }) {
  if (!option.addedBy) return false;
  const allowed = userId === option.addedBy || userId === authorId || (canModerate && option.addedBy !== authorId);
  return allowed && (voters[option.id] ?? []).every((id) => id === option.addedBy || id === userId);
}

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
// `userId`'s votes: { remove: [reaction], add: [optionId] }. `poll` is pollWithAnswers'. Votes
// for answers that no longer exist are cleared too, and answers you added before the question
// changed.
export function planVotes(poll, reactions, userId, optionIds) {
  const live = new Set(poll.options.map((o) => o.id));
  const wanted = new Set(optionIds.filter((id) => live.has(id)).slice(0, poll.multi ? undefined : 1));
  const mine = (reactions ?? []).filter((r) => r.user_id === userId && isVote(r.emoji));
  const kept = new Set();
  // Answers you added before the question changed are gone for good.
  const remove = poll.open
    ? (reactions ?? []).filter((r) => r.user_id === userId && parseAnswer(r.emoji) && parseAnswer(r.emoji).round !== poll.round)
    : [];
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
