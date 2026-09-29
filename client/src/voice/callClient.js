import { onCallEvent } from '../utils/ws-client';
import { fetchUsersList } from '../services/dmService';
import { checkContactKeys } from '../services/contactKeys';
import { loadEncryptionKey } from '../services/keyStore';
import {
  callKeyContext,
  decryptCallKey,
  deriveConversationKey,
  encryptCallKey,
  generateCallKey,
} from '../services/encryptionService';
import {
  acceptCallRequest,
  declineCallRequest,
  fetchCurrentCall,
  hangUpRequest,
  startCallRequest,
} from '../services/callService';
import { getVoiceSnapshot, joinCall, leaveVoice, setVoiceError } from './voiceClient';
import { startTone, stopTone } from './ringtone';

// DM voice calls: ringing someone, being rung, answering, declining and hanging up
// (server/calls.js). The audio is voiceClient.js's (joinCall), end-to-end encrypted with a key
// made here for each call: the caller encrypts it with the DM conversation key (so only the
// two of them can open it) and it travels with the call.
//
// Components read it through hooks/useCall.js. `call` is null or { id, peerId, peerName,
// outgoing, state: 'ringing' | 'connecting' | 'active', answeredAt }. This device only shows
// a call it started, one ringing for it, or one it answered.

const NOTICES = {
  declined: (name) => `${name} declined the call.`,
  missed: (name) => `${name} didn't answer.`,
  busy: (name) => `${name} is in another call.`,
};

let me = null;
let snapshot = { call: null };
const listeners = new Set();
// Whether this device answered (or placed) the current call, i.e. is in it.
let inCall = false;
// The incoming call's encrypted key and caller.
let incoming = null;

function set(call) {
  snapshot = { call };
  for (const listener of listeners) listener();
}

export const getCallSnapshot = () => snapshot;

export function onCallChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clear() {
  stopTone();
  inCall = false;
  incoming = null;
  set(null);
}

// The DM conversation key with `peer` (a user row with their public keys), from the key this
// device has pinned for them (checked like opening the chat does). Throws if their key changed.
async function conversationKey(peer) {
  const check = await checkContactKeys(me.id, peer);
  if (!check.encryptionKey) {
    throw new Error(`${peer.username}'s security key changed. Open your chat with them to review it.`);
  }
  const myKey = await loadEncryptionKey();
  if (!myKey) throw new Error('Your keys are missing on this device. Log in again.');
  return deriveConversationKey(myKey, check.encryptionKey);
}

async function findUser(userId) {
  const user = (await fetchUsersList()).find((u) => u.id === userId);
  if (!user) throw new Error('Unknown user');
  return user;
}

const errorText = (err, fallback) => err?.response?.data?.error ?? err?.message ?? fallback;

function handleEvent(event) {
  const current = snapshot.call;
  if (event.type === 'call_incoming') {
    if (current && current.id !== event.call.id) return; // busy here; the server wouldn't ring
    incoming = event.call;
    set({ id: event.call.id, peerId: event.call.caller_id, peerName: event.call.caller_username, outgoing: false, state: 'ringing', answeredAt: null });
    startTone('incoming');
  } else if (event.type === 'call_update') {
    if (!current || current.id !== event.call.id || event.call.state !== 'active') return;
    if (!inCall) {
      // Answered on another of my devices.
      clear();
      return;
    }
    stopTone();
    set({ ...current, state: 'active', answeredAt: event.call.answered_at });
  } else if (event.type === 'call_end') {
    if (!current || current.id !== event.id) return;
    const wasIn = inCall;
    const { peerName, outgoing } = current;
    clear();
    let notice = null;
    if (outgoing && NOTICES[event.reason]) notice = NOTICES[event.reason](peerName);
    else if (!outgoing && !wasIn && (event.reason === 'cancelled' || event.reason === 'missed')) {
      notice = `Missed call from ${peerName}.`;
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
  me = user;
  if (!user) return;
  unsubscribe = onCallEvent(handleEvent);
  fetchCurrentCall()
    .then((call) => {
      if (call && call.state === 'ringing' && call.callee_id === me.id && !snapshot.call) {
        handleEvent({ type: 'call_incoming', call });
      }
    })
    .catch((err) => console.warn('Could not check for calls', err));
}

// Rings `peer` (a user row with public keys). From a click: the call's sound needs one.
export async function startCall(peer) {
  if (snapshot.call) return;
  const id = crypto.randomUUID();
  set({ id, peerId: peer.id, peerName: peer.username, outgoing: true, state: 'ringing', answeredAt: null });
  inCall = true;
  startTone('ringback');
  try {
    const key = generateCallKey();
    const envelope = await encryptCallKey(key, await conversationKey(peer), callKeyContext(id, me.id, peer.id));
    const { url, token } = await startCallRequest(peer.id, id, envelope);
    if (snapshot.call?.id !== id) return; // hung up meanwhile
    await joinCall({ callId: id, url, token, key });
  } catch (err) {
    if (snapshot.call?.id !== id) return;
    console.warn('Could not start the call', err);
    clear();
    hangUpRequest(id).catch(() => {});
    setVoiceError(errorText(err, 'Could not start the call.'));
  }
}

// Answers the call ringing here. From a click.
export async function acceptCall() {
  const call = snapshot.call;
  if (!call || call.outgoing || call.state !== 'ringing' || !incoming) return;
  const offer = incoming;
  stopTone();
  inCall = true;
  set({ ...call, state: 'connecting' });
  try {
    const peer = await findUser(offer.caller_id);
    const key = await decryptCallKey(offer.key_envelope, await conversationKey(peer), callKeyContext(offer.id, offer.caller_id, me.id));
    const { url, token, call: answered } = await acceptCallRequest(offer.id);
    if (snapshot.call?.id !== offer.id) return;
    set({ ...snapshot.call, state: 'active', answeredAt: answered.answered_at });
    await joinCall({ callId: offer.id, url, token, key });
  } catch (err) {
    if (snapshot.call?.id !== offer.id) return;
    console.warn('Could not answer the call', err);
    clear();
    declineCallRequest(offer.id).catch(() => hangUpRequest(offer.id).catch(() => {}));
    setVoiceError(errorText(err, 'Could not answer the call.'));
  }
}

export async function declineCall() {
  const call = snapshot.call;
  if (!call) return;
  clear();
  await declineCallRequest(call.id).catch(() => {});
}

// Hangs up (or, before it's answered, cancels) the call.
export async function hangUp() {
  const call = snapshot.call;
  if (!call) return;
  clear();
  if (getVoiceSnapshot().callId === call.id) await leaveVoice();
  await hangUpRequest(call.id).catch(() => {});
}
