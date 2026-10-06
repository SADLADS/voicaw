// Polls (client utils/pollMarkup.js): a message whose text is `poll:v1:` + JSON { q, multi, d?,
// x?, o }, with votes as reactions `poll:<option id>`. The server only reads them in guilds
// (in DMs and groups they're encrypted): there it enforces the end (`d` seconds after the
// message's timestamp, or `x`, when its author ended it) and keeps edits from reopening one.
const POLL_PREFIX = 'poll:v1:';
// A "poll ended" row's `system` (see pollTimers.js).
const POLL_END = 'poll_end';
const POLL_VOTE = /^poll:[a-z0-9]{8}$/;
// Answers people add to an open poll: `poll:+` + JSON { i: id, r: round, t: text } (client
// pollMarkup.js). In guilds the server removes them itself, so the author's `poll:-<id>`
// removals aren't used there.
const ANSWER_PREFIX = 'poll:+';
const POLL_REACTION_PREFIX = 'poll:';
const OPTION_ID = /^[a-z0-9]{8}$/;
const MAX_OPTIONS = 20;
const MAX_ANSWER_LENGTH = 55;
const MAX_DURATION = 14 * 86400;
// How far an early end's time may be from the server's clock.
const END_CLOCK_SLACK = 300;

const positiveInt = (n, max = Infinity) => (Number.isInteger(n) && n > 0 && n <= max ? n : null);

// { question, multi, open, round, duration, endedAt, options: [{ id, text }] } for a poll
// message's content, else null.
function parsePoll(content) {
  if (typeof content !== 'string' || !content.startsWith(POLL_PREFIX)) return null;
  try {
    const data = JSON.parse(content.slice(POLL_PREFIX.length));
    if (!data || typeof data.q !== 'string' || !Array.isArray(data.o)) return null;
    const open = data.open === true && OPTION_ID.test(data.r);
    return {
      question: data.q,
      multi: data.multi === true,
      open,
      round: open ? data.r : null,
      duration: positiveInt(data.d, MAX_DURATION),
      endedAt: positiveInt(data.x),
      options: data.o
        .filter((o) => o && OPTION_ID.test(o.id) && typeof o.t === 'string')
        .slice(0, MAX_OPTIONS)
        .map((o) => ({ id: o.id, text: o.t })),
    };
  } catch {
    return null;
  }
}

// An added answer's text as the app stores it: one line, no control characters, trimmed.
function cleanAnswer(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const sameAnswer = (text) => cleanAnswer(text).toLowerCase();

// { id, round, text } of an added answer's reaction (exactly as the app makes them), else null.
function parseAnswer(emoji) {
  if (typeof emoji !== 'string' || !emoji.startsWith(ANSWER_PREFIX)) return null;
  try {
    const data = JSON.parse(emoji.slice(ANSWER_PREFIX.length));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 3) return null;
    const { i: id, r: round, t: text } = data;
    if (!OPTION_ID.test(id) || !OPTION_ID.test(round) || typeof text !== 'string') return null;
    if (!text || text.length > MAX_ANSWER_LENGTH || cleanAnswer(text) !== text) return null;
    return { id, round, text };
  } catch {
    return null;
  }
}

// The answers added to the open `poll` that count, from its reactions ([{ id, user_id, emoji,
// timestamp }]): this round's, oldest first, none repeating an earlier answer (ignoring case)
// or id, up to MAX_OPTIONS answers in all (the client's pollWithAnswers, without the closing
// time: none can be added after it here). -> [{ id, text, userId, reactionIds }]
function addedAnswers(poll, reactions) {
  const ids = new Set(poll.options.map((o) => o.id));
  const texts = new Set(poll.options.map((o) => sameAnswer(o.text)));
  const answers = new Map();
  const sorted = [...reactions].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  for (const r of sorted) {
    const answer = parseAnswer(r.emoji);
    if (!answer || answer.round !== poll.round) continue;
    const same = answers.get(answer.id);
    if (same && same.userId === r.user_id && same.text === answer.text) {
      same.reactionIds.push(r.id);
      continue;
    }
    if (ids.has(answer.id) || texts.has(sameAnswer(answer.text))) continue;
    ids.add(answer.id);
    texts.add(sameAnswer(answer.text));
    if (poll.options.length + answers.size >= MAX_OPTIONS) continue;
    answers.set(answer.id, { id: answer.id, text: answer.text, userId: r.user_id, reactionIds: [r.id] });
  }
  return [...answers.values()];
}

// Why `emoji` (an added answer) can't go on the open `poll` with these `reactions`, or null.
function answerError(poll, reactions, emoji) {
  const answer = parseAnswer(emoji);
  if (!poll.open) return "Answers can't be added to this poll";
  if (!answer || answer.round !== poll.round) return 'Invalid answer';
  const answers = addedAnswers(poll, reactions);
  const all = [...poll.options, ...answers];
  if (all.some((o) => o.id === answer.id)) return 'Invalid answer';
  if (all.some((o) => sameAnswer(o.text) === sameAnswer(answer.text))) return 'That answer is already in the poll';
  if (all.length >= MAX_OPTIONS) return `A poll can have at most ${MAX_OPTIONS} answers`;
  return null;
}

const isPollReaction = (emoji) => typeof emoji === 'string' && emoji.startsWith(POLL_REACTION_PREFIX);

// When a poll sent at `sentAt` (unix s) closes, or null if it never does.
function pollEndsAt(poll, sentAt) {
  const byDuration = poll.duration ? sentAt + poll.duration : null;
  if (byDuration && poll.endedAt) return Math.min(byDuration, poll.endedAt);
  return byDuration ?? poll.endedAt ?? null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Whether a message (content + timestamp) is a poll that has closed.
function isClosedPoll(message) {
  const poll = parsePoll(message.content);
  const endsAt = poll && pollEndsAt(poll, message.timestamp);
  return endsAt != null && nowSeconds() >= endsAt;
}

// Why editing the poll `message` to `content` isn't allowed, or null if it is: a closed poll
// can't change; an open one stays a poll with the same kind and duration, and can only be
// ended (at about now), not un-ended.
function pollEditError(message, content) {
  const before = parsePoll(message.content);
  if (!before) return null;
  if (isClosedPoll(message)) return 'This poll has closed';
  const after = parsePoll(content);
  if (!after) return 'A poll has to stay a poll';
  if (after.multi !== before.multi || after.open !== before.open || after.duration !== before.duration) {
    return "A poll's kind and duration can't be changed";
  }
  if (before.endedAt && after.endedAt !== before.endedAt) return "A poll's end can't be changed";
  if (!before.endedAt && after.endedAt && Math.abs(after.endedAt - nowSeconds()) > END_CLOCK_SLACK) {
    return 'A poll can only be ended now';
  }
  return null;
}

// The notification text for a poll: its question.
function pollPreview(content) {
  const poll = parsePoll(content);
  return poll ? `📊 Poll: ${poll.question}` : null;
}

// The message ids whose reactions a page of rows needs: each row's own, and for a "poll ended"
// row its poll's too, since the result is worked out from the poll's votes.
function reactionIdsFor(messages) {
  const ids = new Set(messages.map((m) => m.id));
  for (const m of messages) if (m.system === POLL_END && m.parent_message_id) ids.add(m.parent_message_id);
  return [...ids];
}

// A "poll ended" row's `poll_reactions` (the poll's votes), if its reader can see the poll.
function pollReactionsFor(message, byMessage) {
  if (message.system !== POLL_END) return {};
  return { poll_reactions: message.parent_content != null ? byMessage.get(message.parent_message_id) ?? [] : [] };
}

module.exports = {
  POLL_END, reactionIdsFor, pollReactionsFor, POLL_VOTE, parsePoll, pollEndsAt, isClosedPoll, pollEditError, pollPreview,
  ANSWER_PREFIX, isPollReaction, parseAnswer, addedAnswers, answerError,
};
