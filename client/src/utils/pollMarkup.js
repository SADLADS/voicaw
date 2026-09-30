// A poll is a message whose whole text is `poll:v1:` + JSON:
//   { "q": question, "multi": false, "o": [{ "id": "k3j2h4g5", "t": "Answer" }, ...] }
// so in DMs and group DMs it's inside the encryption like any message. Votes are reactions
// whose "emoji" is `poll:<option id>` (VOTE_PREFIX): stored, encrypted (DMs, groups), signed
// (groups) and delivered exactly like reactions, so the server can't tell a vote from a
// reaction in encrypted chats. Reaction chips leave them out (utils/reactions.js).
//
// Editing a poll gives every option whose text changed a new id, so the votes it had stop
// counting (they point at an id that's gone). Voting clears your own such leftovers.

export const POLL_PREFIX = 'poll:v1:';
export const VOTE_PREFIX = 'poll:';
export const MAX_POLL_OPTIONS = 10;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_OPTION_LENGTH = 55;

const OPTION_ID = /^[a-z0-9]{8}$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newOptionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

// { question, multi, options: [{ id, text }] } -> message text.
export function pollMarkup({ question, multi, options }) {
  return POLL_PREFIX + JSON.stringify({
    q: question,
    multi: Boolean(multi),
    o: options.map((o) => ({ id: o.id, t: o.text })),
  });
}

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
    options.push({ id: o.id, text: o.t.slice(0, MAX_OPTION_LENGTH) });
  }
  if (options.length === 0) return null;
  return { question: data.q.slice(0, MAX_QUESTION_LENGTH), multi: data.multi === true, options };
}

// The poll after an edit: options keep their id only if their text is unchanged (so votes on
// an edited option are dropped); new ones get a new id. `multi` can't change.
export function editedPoll(original, { question, options }) {
  const unused = new Map();
  for (const o of original.options) {
    if (!unused.has(o.text)) unused.set(o.text, o.id);
  }
  return {
    question,
    multi: original.multi,
    options: options.map((o) => {
      const keep = o.id && original.options.some((old) => old.id === o.id && old.text === o.text);
      return { id: keep ? o.id : newOptionId(), text: o.text };
    }),
  };
}

// For plain-text places (reply previews, notifications, copying).
export function pollSummary(poll) {
  return `📊 Poll: ${poll.question}`;
}

export const voteKey = (optionId) => VOTE_PREFIX + optionId;
export const isVote = (emoji) => typeof emoji === 'string' && emoji.startsWith(VOTE_PREFIX);
export const voteOption = (emoji) => (isVote(emoji) ? emoji.slice(VOTE_PREFIX.length) : null);

// Who voted for what: { voters: { optionId: [userId] }, total (people who voted) }. Votes for
// options that no longer exist don't count. In a single-choice poll only each person's latest
// vote counts (two devices could race).
export function tallyVotes(poll, reactions) {
  const voters = Object.fromEntries(poll.options.map((o) => [o.id, []]));
  const votes = (reactions ?? []).filter((r) => voters[voteOption(r.emoji)]);
  const counted = poll.multi
    ? votes
    : [...new Map(votes.map((r) => [r.user_id, r])).values()];
  const people = new Set();
  for (const r of counted) {
    const list = voters[voteOption(r.emoji)];
    if (!list.includes(r.user_id)) list.push(r.user_id);
    people.add(r.user_id);
  }
  return { voters, total: people.size };
}

// What voting for `optionId` does with `userId`'s votes: { remove: [reaction], add: bool }.
// Voting for an option you already voted for takes the vote back. A single-choice poll
// replaces your vote; either way your votes for options that no longer exist are cleared.
export function planVote(poll, reactions, userId, optionId) {
  const live = new Set(poll.options.map((o) => o.id));
  const mine = (reactions ?? []).filter((r) => r.user_id === userId && isVote(r.emoji));
  const stale = mine.filter((r) => !live.has(voteOption(r.emoji)));
  const same = mine.filter((r) => voteOption(r.emoji) === optionId);
  if (same.length > 0) return { remove: [...stale, ...same], add: false };
  const others = poll.multi ? [] : mine.filter((r) => live.has(voteOption(r.emoji)));
  return { remove: [...stale, ...others], add: true };
}
