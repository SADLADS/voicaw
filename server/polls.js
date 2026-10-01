// Polls (client utils/pollMarkup.js): a message whose text is `poll:v1:` + JSON { q, multi, d?,
// x?, o }, with votes as reactions `poll:<option id>`. The server only reads them in guilds
// (in DMs and groups they're encrypted): there it enforces the end (`d` seconds after the
// message's timestamp, or `x`, when its author ended it) and keeps edits from reopening one.
const POLL_PREFIX = 'poll:v1:';
// A "poll ended" row's `system` (see pollTimers.js).
const POLL_END = 'poll_end';
const POLL_VOTE = /^poll:[a-z0-9]{8}$/;
const MAX_DURATION = 14 * 86400;
// How far an early end's time may be from the server's clock.
const END_CLOCK_SLACK = 300;

const positiveInt = (n, max = Infinity) => (Number.isInteger(n) && n > 0 && n <= max ? n : null);

// { question, multi, duration, endedAt } for a poll message's content, else null.
function parsePoll(content) {
  if (typeof content !== 'string' || !content.startsWith(POLL_PREFIX)) return null;
  try {
    const data = JSON.parse(content.slice(POLL_PREFIX.length));
    if (!data || typeof data.q !== 'string' || !Array.isArray(data.o)) return null;
    return {
      question: data.q,
      multi: data.multi === true,
      duration: positiveInt(data.d, MAX_DURATION),
      endedAt: positiveInt(data.x),
    };
  } catch {
    return null;
  }
}

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
  if (after.multi !== before.multi || after.duration !== before.duration) {
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

module.exports = { POLL_END, reactionIdsFor, pollReactionsFor, POLL_VOTE, parsePoll, pollEndsAt, isClosedPoll, pollEditError, pollPreview };
