// Fixed-window counters (in memory, so they reset when the server restarts, which is fine
// for slowing down password guessing). One limiter per rule, keyed by e.g. IP or username.
const MAX_KEYS = 100000;

function createLimiter({ windowMs, max }) {
  const windows = new Map(); // key -> { count, resetAt }

  function prune(now) {
    for (const [key, w] of windows) {
      if (w.resetAt <= now) windows.delete(key);
    }
    // Still huge (many distinct keys within one window): forget the oldest.
    while (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value);
  }

  return {
    // Counts an attempt; resolves whether it's allowed and, if not, how long until it is.
    hit(key) {
      const now = Date.now();
      if (windows.size > MAX_KEYS / 2) prune(now);
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return { allowed: w.count <= max, retryAfterMs: w.resetAt - now };
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

// Sends 429 Too Many Requests with a Retry-After and a message people can act on.
function tooManyAttempts(res, retryAfterMs) {
  const seconds = Math.ceil(retryAfterMs / 1000);
  const minutes = Math.ceil(seconds / 60);
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  });
}

module.exports = { createLimiter, tooManyAttempts };
