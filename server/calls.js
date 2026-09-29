const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');
const voice = require('./voice');

// DM voice calls: one person rings another, and both talk through LiveKit (room
// `call-<id>`), end-to-end encrypted. The caller makes the call's key and sends it encrypted
// with the DM conversation key (`key_envelope`, which this server can't open); both clients
// give it to LiveKit's E2EE, so LiveKit only ever forwards ciphertext too.
//
// A call rings for RING_MS on every device of the person called (websocket `call_incoming`
// and a push), then counts as missed. Answering on one device stops the others ringing
// (`call_update`). Either person hanging up, or leaving LiveKit, ends it for both
// (`call_end`). Calls live in memory: an API restart forgets them (the people in one keep
// talking until they hang up). A user is in at most one call, and never in a call and a
// voice channel at once.

const RING_MS = 45 * 1000;
const ROOM_PREFIX = 'call-';

// id -> { id, callerId, callerName, calleeId, calleeName, keyEnvelope, state, createdAt,
//         answeredAt, timer }
const calls = new Map();

const roomName = (callId) => `${ROOM_PREFIX}${callId}`;

function callOf(userId) {
  for (const call of calls.values()) {
    if (call.callerId === userId || call.calleeId === userId) return call;
  }
  return null;
}

// What clients see.
function publicCall(call) {
  return {
    id: call.id,
    caller_id: call.callerId,
    caller_username: call.callerName,
    callee_id: call.calleeId,
    callee_username: call.calleeName,
    key_envelope: call.keyEnvelope,
    state: call.state,
    created_at: call.createdAt,
    answered_at: call.answeredAt,
  };
}

function tellBoth(call, payload) {
  sendToUserSockets(call.callerId, payload);
  sendToUserSockets(call.calleeId, payload);
}

async function pushToCallee(call, body) {
  try {
    await sendPushToUser(call.calleeId, {
      type: 'call',
      title: call.callerName,
      body,
      url: `/dm/${call.callerId}`,
      tag: `call-${call.id}`,
      image: await getUserImageUrl(call.callerId),
      timestamp: Math.floor(Date.now() / 1000),
    }, { TTL: Math.ceil(RING_MS / 1000), urgency: 'high' });
  } catch (err) {
    console.error('Call push failed:', err.message);
  }
}

// Ends the call for both. `reason`: 'ended' | 'declined' | 'cancelled' | 'missed' | 'busy'.
async function endCall(call, reason) {
  if (calls.get(call.id) !== call) return;
  calls.delete(call.id);
  clearTimeout(call.timer);
  tellBoth(call, { type: 'call_end', id: call.id, reason });
  voice.livekit.roomService?.deleteRoom(roomName(call.id))
    .catch((err) => voice.logLiveKitError('closing a call', err));
  // The ringing notification becomes a missed call.
  if (reason === 'missed' || reason === 'cancelled') await pushToCallee(call, 'Missed call');
}

async function endCallOf(userId, reason = 'ended') {
  const call = callOf(userId);
  if (call) await endCall(call, call.state === 'ringing' && call.callerId === userId ? 'cancelled' : reason);
}

// The caller rings `callee` ({ id, username }). `id` is made by the caller (a UUID: it's bound
// into the encrypted key). Throws { status, message } when it can't.
async function startCall({ id, caller, callee, keyEnvelope }) {
  if (callOf(callee.id)) throw Object.assign(new Error(`${callee.username} is in another call`), { status: 409 });
  if (calls.has(id)) throw Object.assign(new Error('Call already exists'), { status: 409 });
  await endCallOf(caller.id);
  await voice.disconnect(caller.id);

  const call = {
    id,
    callerId: caller.id,
    callerName: caller.username,
    calleeId: callee.id,
    calleeName: callee.username,
    keyEnvelope,
    state: 'ringing',
    createdAt: Date.now(),
    answeredAt: null,
  };
  call.timer = setTimeout(() => endCall(call, 'missed'), RING_MS);
  call.timer.unref?.();
  calls.set(id, call);

  sendToUserSockets(callee.id, { type: 'call_incoming', call: publicCall(call) });
  // The caller's other devices show it too.
  sendToUserSockets(caller.id, { type: 'call_update', call: publicCall(call) });
  pushToCallee(call, 'Incoming voice call');
  return call;
}

async function acceptCall(call) {
  clearTimeout(call.timer);
  call.state = 'active';
  call.answeredAt = Date.now();
  await voice.disconnect(call.calleeId);
  tellBoth(call, { type: 'call_update', call: publicCall(call) });
}

const tokenFor = (call, userId, username) =>
  voice.roomToken({ room: roomName(call.id), userId, username, canSpeak: true });

// How long someone may be gone from a call's room before it ends: LiveKit's client rejoins
// after a bad network change, which reads as leaving and joining again.
const REJOIN_GRACE_MS = 10 * 1000;

// LiveKit webhooks for call rooms (voice.js passes them on): someone leaving ends the call
// (unless they're back within REJOIN_GRACE_MS).
async function handleWebhookEvent(event) {
  const call = calls.get(event.room.name.slice(ROOM_PREFIX.length));
  if (!call) return;
  const reason = call.state === 'ringing' ? 'cancelled' : 'ended';
  if (event.event === 'room_finished') {
    await endCall(call, reason);
  } else if (event.event === 'participant_left') {
    const { roomService } = voice.livekit;
    if (!roomService) {
      await endCall(call, reason);
      return;
    }
    const identity = event.participant?.identity;
    setTimeout(async () => {
      try {
        const participants = await roomService.listParticipants(roomName(call.id));
        if (participants.some((p) => p.identity === identity)) return;
      } catch {
        // The room is gone: so is the call.
      }
      await endCall(call, reason);
    }, REJOIN_GRACE_MS).unref?.();
  }
}

async function userById(id) {
  if (!Number.isInteger(id)) return null;
  return db.get('SELECT id, username FROM users WHERE id = ?', [id]);
}

module.exports = {
  RING_MS,
  calls,
  callOf,
  publicCall,
  startCall,
  acceptCall,
  endCall,
  endCallOf,
  tokenFor,
  handleWebhookEvent,
  userById,
};
