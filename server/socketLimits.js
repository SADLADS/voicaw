// How many websockets one address may hold open before they identify, for the app's socket
// (sockets.js) and bots' gateway (gateway.js) alike (security audit, 2026-11-18): each costs
// memory (a gateway one with zlib-stream also a deflate stream, made before Identify since its
// HELLO is compressed too), and logged-out visitors can open them.
const MAX_UNIDENTIFIED_PER_ADDRESS = 20;
const unidentified = new Map(); // address -> sockets open that haven't identified

// The visitor's address: nginx's X-Forwarded-For when the connection is from nginx on this
// host (as Express's 'trust proxy' = loopback), else the connection's own.
function addressOf(req) {
  const direct = req?.socket?.remoteAddress ?? '';
  if (/^(::ffff:)?127\.|^::1$/.test(direct)) {
    const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',').pop().trim();
    if (forwarded) return forwarded;
  }
  return direct;
}

// Counts a new socket from `req`'s address. Resolves to a function to call once it has
// identified or closed (more calls do nothing), or null when the address has too many already.
function holdUnidentified(req) {
  const address = addressOf(req);
  const count = (unidentified.get(address) ?? 0) + 1;
  if (count > MAX_UNIDENTIFIED_PER_ADDRESS) return null;
  unidentified.set(address, count);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (unidentified.get(address) ?? 1) - 1;
    if (left > 0) unidentified.set(address, left);
    else unidentified.delete(address);
  };
}

module.exports = { MAX_UNIDENTIFIED_PER_ADDRESS, addressOf, holdUnidentified };
