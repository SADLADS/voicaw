import { onCallEvent } from '../utils/ws-client';
import { fetchUsersList } from '../services/dmService';
import { checkContactKeys } from '../services/contactKeys';
import { loadEncryptionKey, loadIdentityKey } from '../services/keyStore';
import {
  callKeyContext,
  decryptCallKey,
  deriveConversationKey,
  encryptCallKey,
  generateCallKey,
} from '../services/encryptionService';
import {
  callKeySignatureContext,
  decryptGroupCallKey,
  encryptGroupCallKey,
  groupCallKeyContext,
} from '../services/groupCrypto';
import { currentEpoch, openGroup } from '../services/groupKeys';
import {
  acceptCallRequest,
  declineCallRequest,
  fetchCurrentCall,
  hangUpRequest,
  startCallRequest,
  startGroupCallRequest,
} from '../services/callService';
import { getVoiceSnapshot, joinCall, leaveVoice, setVoiceError } from './voiceClient';
import { startLoop, stopLoop } from '../sounds/sounds';
import { isAndroidApp } from '../utils/android';
import { getPushStatus } from '../services/pushService';
import { t } from '../i18n';

// DM and group DM voice calls: ringing, being rung, answering or joining, declining and
// hanging up (server/calls.js). The audio is voiceClient.js's (joinCall), end-to-end encrypted
// with a key made here for each call. The caller encrypts it with the DM conversation key, or
// for a group with the group's current epoch key (so only its members can open it) and signed
// with the caller's identity key (so nobody can start one in someone else's name), and it
// travels with the call.
//
// Components read it through hooks/useCall.js. `call` is this device's call: null or { id,
// groupId (null: 1:1), peerId, peerName (1:1), callerName, outgoing, state: 'ringing' |
// 'connecting' | 'active', answeredAt, participants (group) }. This device only shows a call it
// started, one ringing for it, or one it answered or joined. `groupCalls` is every call going
// on in your groups (by group id, the server's shape), so a group can show "Join".

const NOTICES = {
  declined: (name) => t('calls.notices.declined', { name }),
  missed: (name) => t('calls.notices.noAnswer', { name }),
  busy: (name) => t('calls.notices.busy', { name }),
};

let me = null;
let snapshot = { call: null, groupCalls: {} };
const listeners = new Set();
// Whether this device answered (or placed, or joined) the current call, i.e. is in it.
let inCall = false;
// The incoming call as the server sent it (its encrypted key and caller).
let incoming = null;

function emit(changes) {
  snapshot = { ...snapshot, ...changes };
  for (const listener of listeners) listener();
}
const set = (call) => emit({ call });

function setGroupCall(groupId, call) {
  const groupCalls = { ...snapshot.groupCalls };
  if (call) groupCalls[groupId] = call;
  else delete groupCalls[groupId];
  emit({ groupCalls });
}

export const getCallSnapshot = () => snapshot;

export function onCallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clear() {
  stopLoop();
  inCall = false;
  incoming = null;
  set(null);
}

// The DM conversation key with `peer` (a user row with their public keys), from the key this
// device has pinned for them (checked like opening the chat does). Throws if their key changed.
async function conversationKey(peer) {
  const check = await checkContactKeys(me.id, peer);
  if (!check.encryptionKey) {
    throw new Error(t('calls.errors.keyChanged', { name: peer.username }));
  }
  const myKey = await loadEncryptionKey();
  if (!myKey) throw new Error(t('calls.errors.keysMissing'));
  return deriveConversationKey(myKey, check.encryptionKey);
}

async function findUser(userId) {
  const user = (await fetchUsersList()).find((u) => u.id === userId);
  if (!user) throw new Error(t('calls.errors.unknownUser'));
  return user;
}

const errorText = (err, fallback) => err?.response?.data?.error ?? err?.message ?? fallback;

// A server timestamp in this device's time (its clock can be off from the server's by minutes).
function localTime(serverTime, call) {
  if (!serverTime) return serverTime;
  return call.server_now ? serverTime - call.server_now + Date.now() : serverTime;
}

// This device's view of a call the server sent.
function localCall(call, fields) {
  return call.group_id
    ? { id: call.id, groupId: call.group_id, callerId: call.caller_id, callerName: call.caller_username, participants: call.participants, answeredAt: localTime(call.answered_at, call), ...fields }
    : { id: call.id, groupId: null, peerId: call.caller_id, peerName: call.caller_username, callerId: call.caller_id, callerName: call.caller_username, answeredAt: null, ...fields };
}

function handleEvent(event) {
  const current = snapshot.call;
  if (event.type === 'call_incoming' || event.type === 'call_update') {
    if (event.call.group_id) setGroupCall(event.call.group_id, event.call);
  }
  if (event.type === 'call_incoming') {
    if (current) return; // busy on this device
    incoming = event.call;
    set(localCall(event.call, { outgoing: false, state: 'ringing' }));
    // The Android app rings itself, from the call's push (one ringtone, also when closed).
    if (!(isAndroidApp() && getPushStatus() === 'granted')) startLoop('incomingRing');
  } else if (event.type === 'call_update') {
    const call = event.call;
    if (!current || current.id !== call.id) return;
    if (call.group_id) {
      if (inCall) set({ ...current, participants: call.participants });
      // Ringing here, but not any more: declined or joined on another device, or it rang out.
      else if (!call.ringing.includes(me.id)) clear();
      return;
    }
    if (call.state !== 'active') return;
    if (!inCall) {
      // Answered on another of my devices.
      clear();
      return;
    }
    stopLoop();
    set({ ...current, state: 'active', answeredAt: localTime(call.answered_at, call) });
  } else if (event.type === 'call_end') {
    for (const [groupId, call] of Object.entries(snapshot.groupCalls)) {
      if (call.id === event.id) setGroupCall(groupId, null);
    }
    if (!current || current.id !== event.id) return;
    const wasIn = inCall;
    const { peerName, outgoing, groupId, callerName } = current;
    clear();
    let notice = null;
    if (groupId) {
      if (!wasIn) notice = t('calls.notices.missedGroup', { name: callerName });
    } else if (outgoing && NOTICES[event.reason]) {
      notice = NOTICES[event.reason](peerName);
    } else if (!outgoing && !wasIn && (event.reason === 'cancelled' || event.reason === 'missed')) {
      notice = t('calls.notices.missed', { name: peerName });
    }
    // After leaving (which clears the voice bar's message).
    const left = getVoiceSnapshot().callId === event.id ? leaveVoice() : Promise.resolve();
    left.then(() => notice && setVoiceError(notice));
  }
}

let unsubscribe = null;

// Called by Layout once logged in (and with null on logout): listens for calls, and picks up
// one already ringing (the app was opened from the call's notification).
export function initCalls(user) {
  unsubscribe?.();
  unsubscribe = null;
  clear();
  emit({ groupCalls: {} });
  me = user;
  if (!user) return;
  unsubscribe = onCallEvent(handleEvent);
  fetchCurrentCall()
    .then((call) => {
      const ringingForMe = call && (call.group_id ? call.ringing.includes(me.id) : call.state === 'ringing' && call.callee_id === me.id);
      if (ringingForMe && !snapshot.call) handleEvent({ type: 'call_incoming', call });
    })
    .catch((err) => console.warn('Could not check for calls', err));
}

// A group's call as the server gave it with the group (GET /group-dms/:id), so the group
// shows it even if it started before this page loaded.
export function noteGroupCall(groupId, call) {
  if ((snapshot.groupCalls[groupId]?.id ?? null) !== (call?.id ?? null)) setGroupCall(groupId, call);
}

// Rings `peer` (a user row with public keys). From a click: the call's sound needs one.
export async function startCall(peer) {
  if (snapshot.call) return;
  const id = crypto.randomUUID();
  set({ id, groupId: null, peerId: peer.id, peerName: peer.username, callerName: me.username, outgoing: true, state: 'ringing', answeredAt: null });
  inCall = true;
  startLoop('outgoingRing');
  try {
    const key = generateCallKey();
    const envelope = await encryptCallKey(key, await conversationKey(peer), callKeyContext(id, me.id, peer.id));
    const { url, token, streamLimit } = await startCallRequest(peer.id, id, envelope);
    if (snapshot.call?.id !== id) return; // hung up meanwhile
    await joinCall({ callId: id, url, token, streamLimit, key });
  } catch (err) {
    if (snapshot.call?.id !== id) return;
    console.warn('Could not start the call', err);
    clear();
    hangUpRequest(id).catch(() => {});
    setVoiceError(errorText(err, t('calls.errors.start')));
  }
}

// Joins a group's call (`call`: the server's shape), opening its key with the group's epoch key.
async function joinGroupCall(call) {
  stopLoop();
  inCall = true;
  set(localCall(call, { outgoing: call.caller_id === me.id, state: 'connecting' }));
  try {
    const group = await openGroup(me, call.group_id);
    const epochKey = group.keys.get(call.key_epoch);
    if (!epochKey) throw new Error(t('calls.errors.joinedAfter'));
    const key = await decryptGroupCallKey(
      call.key_envelope, epochKey, groupCallKeyContext(call.id, call.group_id, call.key_epoch, call.caller_id),
      group.log.identityKeys.get(call.caller_id),
      callKeySignatureContext({ callId: call.id, groupId: call.group_id, epoch: call.key_epoch, callerId: call.caller_id })
    ).catch((err) => {
      console.warn('Group call key', err);
      throw new Error(t('calls.errors.unverified'));
    });
    const { url, token, streamLimit, call: joined } = await acceptCallRequest(call.id);
    if (snapshot.call?.id !== call.id) return;
    set(localCall(joined, { outgoing: joined.caller_id === me.id, state: 'active' }));
    await joinCall({ callId: call.id, url, token, streamLimit, key });
  } catch (err) {
    if (snapshot.call?.id !== call.id) return;
    console.warn('Could not join the call', err);
    clear();
    setVoiceError(errorText(err, t('calls.errors.join')));
  }
}

// Starts a call in a group (or joins the one already going). From a click.
export async function startGroupCall(groupId) {
  if (snapshot.call) return;
  const existing = snapshot.groupCalls[groupId];
  if (existing) {
    await joinGroupCall(existing);
    return;
  }
  const id = crypto.randomUUID();
  set({ id, groupId, callerName: me.username, outgoing: true, state: 'connecting', participants: [me.id], answeredAt: null });
  inCall = true;
  try {
    const { epoch, key: epochKey } = await currentEpoch(me, groupId);
    const key = generateCallKey();
    const envelope = await encryptGroupCallKey(
      key, epochKey, groupCallKeyContext(id, groupId, epoch, me.id), await loadIdentityKey(),
      callKeySignatureContext({ callId: id, groupId, epoch, callerId: me.id })
    );
    let started;
    try {
      started = await startGroupCallRequest(groupId, id, epoch, envelope);
    } catch (err) {
      // Someone started one meanwhile: join theirs.
      if (err.response?.status === 409 && err.response.data?.call) {
        clear();
        await joinGroupCall(err.response.data.call);
        return;
      }
      throw err;
    }
    if (snapshot.call?.id !== id) return;
    setGroupCall(groupId, started.call);
    set(localCall(started.call, { outgoing: true, state: 'active' }));
    await joinCall({ callId: id, url: started.url, token: started.token, streamLimit: started.streamLimit, key });
  } catch (err) {
    if (snapshot.call?.id !== id) return;
    console.warn('Could not start the call', err);
    clear();
    hangUpRequest(id).catch(() => {});
    setVoiceError(errorText(err, t('calls.errors.start')));
  }
}

// Joins a group's call from its page (not rung, or rung earlier).
export async function joinGroupCallById(groupId) {
  const call = snapshot.groupCalls[groupId];
  if (call && !snapshot.call) await joinGroupCall(call);
}

// Answers the call ringing here (a group call: joins it). From a click.
export async function acceptCall() {
  const call = snapshot.call;
  if (!call || call.outgoing || call.state !== 'ringing' || !incoming) return;
  const offer = incoming;
  if (offer.group_id) {
    incoming = null;
    await joinGroupCall(offer);
    return;
  }
  stopLoop();
  inCall = true;
  set({ ...call, state: 'connecting' });
  try {
    const peer = await findUser(offer.caller_id);
    const key = await decryptCallKey(offer.key_envelope, await conversationKey(peer), callKeyContext(offer.id, offer.caller_id, me.id));
    const { url, token, streamLimit, call: answered } = await acceptCallRequest(offer.id);
    if (snapshot.call?.id !== offer.id) return;
    set({ ...snapshot.call, state: 'active', answeredAt: localTime(answered.answered_at, answered) });
    await joinCall({ callId: offer.id, url, token, streamLimit, key });
  } catch (err) {
    if (snapshot.call?.id !== offer.id) return;
    console.warn('Could not answer the call', err);
    clear();
    declineCallRequest(offer.id).catch(() => hangUpRequest(offer.id).catch(() => {}));
    setVoiceError(errorText(err, t('calls.errors.answer')));
  }
}

export async function declineCall() {
  const call = snapshot.call;
  if (!call) return;
  clear();
  await declineCallRequest(call.id).catch(() => {});
}

// Hangs up (a 1:1 call ends; before it's answered, the caller cancels it) or leaves a group
// call.
export async function hangUp() {
  const call = snapshot.call;
  if (!call) return;
  clear();
  if (getVoiceSnapshot().callId === call.id) await leaveVoice();
  await hangUpRequest(call.id).catch(() => {});
}
