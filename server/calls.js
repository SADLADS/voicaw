const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');
const voice = require('./voice');
const { displayNameOf } = require('./profiles');
const { logCall } = require('./callLog');

// DM and group DM voice calls, through LiveKit (room `call-<id>`), end-to-end encrypted: the
// caller makes the call's key and sends it encrypted (`key_envelope`, which this server can't
// open) with the DM conversation key, or for a group with its current epoch key
// (`key_epoch`). Clients give it to LiveKit's E2EE, so LiveKit only forwards ciphertext too.
//
// A 1:1 call rings the other person for RING_MS on every device (websocket `call_incoming`
// and a push), then counts as missed. Answering on one device stops the others ringing
// (`call_update`). Either person hanging up, or leaving LiveKit, ends it for both (`call_end`).
//
// A group call rings every other member; each can join (or decline) while it lasts, also
// after the ringing stops. It goes on until the last person leaves. Its events go to every
// member, so the group shows a call in progress. Only one call per group.
//
// Calls live in memory: an API restart forgets them (the people in one keep talking until
// they hang up). A user is in at most one call, and never in a call and a voice channel at
// once.

const RING_MS = 45 * 1000;
// How long someone may be gone from a call's room before counting as left: LiveKit's client
// rejoins after a bad network change, which reads as leaving and joining again.
const REJOIN_GRACE_MS = 10 * 1000;
const ROOM_PREFIX = 'call-';

// id -> { id, groupId (null: a 1:1 call), groupName, callerId, callerName, calleeId,
//         calleeName, keyEnvelope, keyEpoch, state, createdAt, answeredAt, timer,
//         ringing: Set, participants: Set (group calls: who's in), joined: Set (who has been
//         in it, for the chat's call row: see callLog.js) }
const calls = new Map();

const roomName = (callId) => `${ROOM_PREFIX}${callId}`;

function isIn(call, userId) {
  if (!call.groupId) return call.callerId === userId || call.calleeId === userId;
  return call.participants.has(userId);
}

function callOf(userId) {
  for (const call of calls.values()) if (isIn(call, userId)) return call;
  return null;
}

function groupCall(groupId) {
  for (const call of calls.values()) if (call.groupId === groupId) return call;
  return null;
}

// A call ringing for `userId` (for a just-opened app), or the one they're in.
function currentCallFor(userId) {
  for (const call of calls.values()) {
    if (isIn(call, userId) || call.ringing.has(userId)) return call;
  }
  return null;
}

// What clients see.
function publicCall(call) {
  return {
    id: call.id,
    group_id: call.groupId,
    group_name: call.groupName,
    caller_id: call.callerId,
    caller_username: call.callerName,
    callee_id: call.calleeId,
    callee_username: call.calleeName,
    key_envelope: call.keyEnvelope,
    key_epoch: call.keyEpoch,
    state: call.state,
    created_at: call.createdAt,
    answered_at: call.answeredAt,
    // The server's clock when this was sent, so a device whose clock is off can turn
    // answered_at into its own time (else a call timer stays at 0:00 or starts ahead).
    server_now: Date.now(),
    ringing: [...call.ringing],
    participants: [...call.participants],
  };
}

async function audience(call) {
  if (!call.groupId) return [call.callerId, call.calleeId];
  const rows = await db.all('SELECT user_id FROM group_dm_members WHERE group_id = ?', [call.groupId]);
  return rows.map((r) => r.user_id);
}

async function tellAll(call, payload) {
  for (const userId of await audience(call)) sendToUserSockets(userId, payload);
}

const announce = (call) => tellAll(call, { type: 'call_update', call: publicCall(call) });

async function push(call, userId, body) {
  try {
    await sendPushToUser(userId, {
      type: 'call',
      title: call.groupId ? call.groupName || 'Group call' : call.callerName,
      body: call.groupId && body === 'Incoming voice call' ? `${call.callerName} started a call` : body,
      url: call.groupId ? `/dm/g/${call.groupId}` : `/dm/${call.callerId}`,
      tag: `call-${call.id}`,
      image: await getUserImageUrl(call.callerId),
      timestamp: Math.floor(Date.now() / 1000),
    }, { TTL: Math.ceil(RING_MS / 1000), urgency: 'high' });
  } catch (err) {
    console.error('Call push failed:', err.message);
  }
}

function removeFromRoom(call, userId) {
  voice.livekit.roomService?.removeParticipant(roomName(call.id), String(userId))
    .catch((err) => voice.logLiveKitError('removing someone from a call', err));
}

// Ends the call for everyone. `reason`: 'ended' | 'declined' | 'cancelled' | 'missed'.
async function endCall(call, reason) {
  if (calls.get(call.id) !== call) return;
  calls.delete(call.id);
  clearTimeout(call.timer);
  await tellAll(call, { type: 'call_end', id: call.id, reason });
  await logCall(call, reason);
  voice.livekit.roomService?.deleteRoom(roomName(call.id))
    .catch((err) => voice.logLiveKitError('closing a call', err));
  // A ringing notification becomes a missed call.
  const missed = call.groupId ? [...call.ringing] : (reason === 'missed' || reason === 'cancelled' ? [call.calleeId] : []);
  for (const userId of missed) await push(call, userId, 'Missed call');
}

// `userId` leaves a group call (hanging up, or no longer in the group); the last one out ends
// it.
async function leaveCall(call, userId) {
  const wasRinging = call.ringing.delete(userId);
  if (!call.participants.delete(userId) && !wasRinging) return;
  removeFromRoom(call, userId);
  if (call.participants.size === 0) await endCall(call, 'ended');
  else await announce(call);
}

// Hangs up whatever call `userId` is in (a 1:1 call ends; the caller before an answer
// cancels it; a group call carries on without them).
async function endCallOf(userId, reason = 'ended') {
  const call = callOf(userId);
  if (!call) return;
  if (call.groupId) await leaveCall(call, userId);
  else await endCall(call, call.state === 'ringing' && call.callerId === userId ? 'cancelled' : reason);
}

// Someone left the group (or was removed): out of its call.
async function leaveGroupCall(groupId, userId) {
  const call = userId != null && groupCall(groupId);
  if (call) await leaveCall(call, userId);
}

function newCall(fields) {
  return {
    groupId: null,
    groupName: null,
    calleeId: null,
    calleeName: null,
    keyEpoch: null,
    createdAt: Date.now(),
    answeredAt: null,
    ringing: new Set(),
    participants: new Set(),
    joined: new Set(),
    ...fields,
  };
}

// The caller rings `callee` ({ id, username }). `id` is made by the caller (a UUID: it's bound
// into the encrypted key). Throws { status, message } when it can't.
async function startCall({ id, caller, callee, keyEnvelope }) {
  if (callOf(callee.id)) throw Object.assign(new Error(`${callee.username} is in another call`), { status: 409 });
  if (calls.has(id)) throw Object.assign(new Error('Call already exists'), { status: 409 });
  await endCallOf(caller.id);
  await voice.disconnect(caller.id);

  const call = newCall({
    id,
    callerId: caller.id,
    callerName: await displayNameOf(caller.id, caller.username),
    calleeId: callee.id,
    calleeName: callee.username,
    keyEnvelope,
    state: 'ringing',
  });
  call.ringing.add(callee.id);
  call.timer = setTimeout(() => endCall(call, 'missed'), RING_MS);
  call.timer.unref?.();
  calls.set(id, call);

  sendToUserSockets(callee.id, { type: 'call_incoming', call: publicCall(call) });
  // The caller's other devices show it too.
  sendToUserSockets(caller.id, { type: 'call_update', call: publicCall(call) });
  push(call, callee.id, 'Incoming voice call');
  return call;
}

// A group call, rung to every member but the caller who isn't in another call. `members` are
// the group's member ids.
async function startGroupCall({ id, group, caller, keyEnvelope, keyEpoch, members }) {
  if (groupCall(group.id)) throw Object.assign(new Error('There is already a call in this group'), { status: 409 });
  if (calls.has(id)) throw Object.assign(new Error('Call already exists'), { status: 409 });
  await endCallOf(caller.id);
  await voice.disconnect(caller.id);

  const call = newCall({
    id,
    groupId: group.id,
    groupName: group.name,
    callerId: caller.id,
    callerName: await displayNameOf(caller.id, caller.username),
    keyEnvelope,
    keyEpoch,
    state: 'active',
    answeredAt: Date.now(),
  });
  call.participants.add(caller.id);
  call.joined.add(caller.id);
  for (const userId of members) if (userId !== caller.id && !callOf(userId)) call.ringing.add(userId);
  // After a while, nobody's rung any more (the call goes on).
  call.timer = setTimeout(async () => {
    const missed = [...call.ringing];
    call.ringing.clear();
    if (calls.get(call.id) !== call) return;
    await announce(call);
    for (const userId of missed) await push(call, userId, 'Missed call');
  }, RING_MS);
  call.timer.unref?.();
  calls.set(id, call);

  for (const userId of call.ringing) {
    sendToUserSockets(userId, { type: 'call_incoming', call: publicCall(call) });
    push(call, userId, 'Incoming voice call');
  }
  await announce(call);
  return call;
}

// `userId` answers (1:1) or joins (group).
async function acceptCall(call, userId) {
  await voice.disconnect(userId);
  if (call.groupId) {
    // Out of any other call first.
    const other = callOf(userId);
    if (other && other !== call) await endCallOf(userId);
    call.ringing.delete(userId);
    call.participants.add(userId);
    call.joined.add(userId);
  } else {
    clearTimeout(call.timer);
    call.joined.add(call.callerId).add(call.calleeId);
    call.ringing.clear();
    call.state = 'active';
    call.answeredAt = Date.now();
  }
  await announce(call);
}

// Declining: a 1:1 call ends; a group call just stops ringing for them.
async function declineCall(call, userId) {
  if (call.groupId) {
    call.ringing.delete(userId);
    await announce(call);
  } else {
    await endCall(call, 'declined');
  }
}

const tokenFor = (call, userId, username) =>
  voice.roomToken({ room: roomName(call.id), userId, username, canSpeak: true });

// LiveKit webhooks for call rooms (voice.js passes them on): someone gone for good (not back
// within REJOIN_GRACE_MS) ends a 1:1 call, or leaves a group call.
async function handleWebhookEvent(event) {
  const call = calls.get(event.room.name.slice(ROOM_PREFIX.length));
  if (!call) return;
  const userId = Number(event.participant?.identity);
  const gone = async () => {
    if (call.groupId) await leaveCall(call, userId);
    else await endCall(call, call.state === 'ringing' ? 'cancelled' : 'ended');
  };
  if (event.event === 'room_finished') {
    await endCall(call, 'ended');
  } else if (event.event === 'participant_joined' && call.groupId && !call.participants.has(userId)) {
    // Joined through a token from before a rejoin; still a member?
    const member = await db.get('SELECT 1 FROM group_dm_members WHERE group_id = ? AND user_id = ?', [call.groupId, userId]);
    if (member) {
      call.participants.add(userId);
      call.joined.add(userId);
      await announce(call);
    } else {
      removeFromRoom(call, userId);
    }
  } else if (event.event === 'participant_left') {
    const { roomService } = voice.livekit;
    if (!roomService) {
      await gone();
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
      await gone();
    }, REJOIN_GRACE_MS).unref?.();
  }
}

async function userById(id) {
  if (!Number.isInteger(id)) return null;
  return db.get('SELECT id, username FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
}

module.exports = {
  RING_MS,
  calls,
  callOf,
  groupCall,
  currentCallFor,
  publicCall,
  startCall,
  startGroupCall,
  acceptCall,
  declineCall,
  endCall,
  endCallOf,
  leaveGroupCall,
  tokenFor,
  handleWebhookEvent,
  userById,
};
