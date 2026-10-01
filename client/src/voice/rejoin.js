// When a lost voice channel connection is joined again (voiceClient.js). LiveKit retries a
// dropped connection by itself, but can take minutes to give up (ten attempts, each waiting
// for a timeout), and can't get back in with an expired token. So once it gives up, or hasn't
// managed within TAKE_OVER_AFTER_MS, we fetch a new token and join the same channel again,
// for up to REJOIN_FOR_MS. Phones (iOS especially) drop the connection whenever the app is in
// the background, so there it waits until the app is back.

export const REJOIN_FOR_MS = 5 * 60 * 1000;
export const TAKE_OVER_AFTER_MS = 15 * 1000;

// A phone back from the background after longer than this: its connection is most likely
// gone (LiveKit's server lets go after ~20 s), so rejoin at once rather than wait for
// LiveKit to notice and retry (TAKE_OVER_AFTER_MS).
export const STALE_AFTER_HIDDEN_MS = 10 * 1000;

const DELAYS = [0, 1000, 2000, 5000, 10000];

// Milliseconds before rejoin attempt number `tries` (0 first).
export function rejoinDelay(tries) {
  return DELAYS[Math.min(tries, DELAYS.length - 1)];
}

// LiveKit's DisconnectReason numbers (@livekit/protocol) that mean we were meant to be out:
// we left, joined from another device, were removed (lost permission, kicked, moved to
// another channel elsewhere), or the room is gone. Anything else is a lost connection.
const MEANT = new Set([
  1, // CLIENT_INITIATED
  2, // DUPLICATE_IDENTITY
  4, // PARTICIPANT_REMOVED
  5, // ROOM_DELETED
  10, // ROOM_CLOSED
]);

export function shouldRejoin(reason) {
  return !MEANT.has(reason);
}

// The API said no to a new token (no longer allowed, channel gone, voice off): stop trying.
// No answer, a timeout, rate limiting or a server error: try again.
export function joinRefused(err) {
  const status = err?.response?.status;
  if (status === 503) return true;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
