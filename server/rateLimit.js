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
      return { allowed: w.count <= max, retryAfterMs: w.resetAt - now, remaining: Math.max(0, max - w.count) };
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

// Like createLimiter, but counting distinct items per key (the different people someone wrote
// to, say): `hit(key, item)` is allowed for an item already counted in this window, or while
// fewer than `max` are.
function createDistinctLimiter({ windowMs, max }) {
  const windows = new Map(); // key -> { items: Set, resetAt }
  return {
    hit(key, item) {
      const now = Date.now();
      if (windows.size > MAX_KEYS / 2) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
        while (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value);
      }
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { items: new Set(), resetAt: now + windowMs };
        windows.set(key, w);
      }
      if (!w.items.has(item) && w.items.size >= max) return { allowed: false, retryAfterMs: w.resetAt - now };
      w.items.add(item);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// Counts one against `limiter` under `key` (and `item`, for a distinct limiter): the ms to wait
// when over its limit, else 0. Always 0 when the tests turn rate limits off.
function overLimit(limiter, key, item) {
  if (!require('./config').rateLimitsEnabled) return 0;
  const { allowed, retryAfterMs } = limiter.hit(key, item);
  return allowed ? 0 : Math.max(1, retryAfterMs);
}

// The key for limiting by address: IPv4 as it is, IPv6 by its /64 (one home or server usually
// has a whole /64, so counting exact addresses wouldn't limit it at all).
function addressKey(ip) {
  const address = String(ip ?? '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!require('net').isIPv6(address)) return address;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
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

// Express middleware counting each request against `limiter` under `keyOf(req)` (by default the
// logged-in account), answering 429 once over. Off when the tests turn rate limits off.
function limitRequests(limiter, keyOf = (req) => String(req.user?.id ?? req.ip)) {
  return (req, res, next) => {
    if (!require('./config').rateLimitsEnabled) return next();
    const { allowed, retryAfterMs } = limiter.hit(keyOf(req));
    if (!allowed) return tooManyAttempts(res, retryAfterMs);
    next();
  };
}

module.exports = { createLimiter, createDistinctLimiter, overLimit, addressKey, tooManyAttempts, limitRequests };
