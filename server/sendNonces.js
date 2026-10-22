// Sending a message again mustn't save it twice. When the connection drops after the request
// left, the app can't tell whether the message arrived, so its Retry sends it again (see Unsent
// messages in docs/messages.md). Each message the app sends carries a random `nonce`, the same
// on every retry; the server remembers which message each sender's nonce made, in memory only,
// for an hour, and answers a repeat with that message instead of saving another. (A restart
// in between forgets them: a retry then saves a second copy.)

const KEEP_MS = 60 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;

// `${kind}:${userId}:${nonce}` -> { at, id: Promise<message id | null> }. Insertion order is
// age order, so pruning stops at the first one still kept.
const sent = new Map();

function prune(now) {
  for (const [key, entry] of sent) {
    if (now - entry.at < KEEP_MS) break;
    sent.delete(key);
  }
}

// Wraps a send route. `handler(req, res)` sends as before and resolves to the new message's id
// (anything else when it refused). With a nonce already used by this sender, `findExisting(req, id)`
// loads the message it made (null if it's gone), which is answered instead; one still being
// saved is waited for first. A refused or failed first try doesn't count.
function deduplicated(kind, findExisting, handler) {
  return async (req, res) => {
    const nonce = typeof req.body?.nonce === 'string' && NONCE.test(req.body.nonce) ? req.body.nonce : null;
    if (!nonce) return handler(req, res);
    const now = Date.now();
    prune(now);
    const key = `${kind}:${req.user.id}:${nonce}`;
    const earlier = sent.get(key);
    if (earlier) {
      const id = await earlier.id;
      const message = id != null ? await findExisting(req, id) : null;
      if (message) return res.status(201).json(message);
    }
    let settle;
    const entry = { at: now, id: new Promise((resolve) => { settle = resolve; }) };
    sent.delete(key);
    sent.set(key, entry);
    let id = null;
    try {
      // A refusal returns its `res.json(...)`, not an id.
      const result = await handler(req, res);
      if (Number.isInteger(result)) id = result;
    } finally {
      settle(id);
      if (id == null && sent.get(key) === entry) sent.delete(key);
    }
  };
}

module.exports = { deduplicated, _sent: sent };
