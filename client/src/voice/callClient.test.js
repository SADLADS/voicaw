import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({ listeners: new Set() }));
vi.mock('../utils/ws-client', () => ({
  onCallEvent: (cb) => {
    events.listeners.add(cb);
    return () => events.listeners.delete(cb);
  },
}));
vi.mock('../services/callService', () => ({
  fetchCurrentCall: vi.fn(async () => null),
  startCallRequest: vi.fn(async (calleeId, callId) => ({ call: { id: callId }, url: 'wss://lk', token: 'caller-token' })),
  acceptCallRequest: vi.fn(async (callId) => ({ call: { id: callId, answered_at: 1234 }, url: 'wss://lk', token: 'callee-token' })),
  declineCallRequest: vi.fn(async () => {}),
  hangUpRequest: vi.fn(async () => {}),
}));
vi.mock('../services/dmService', () => ({ fetchUsersList: vi.fn() }));
vi.mock('../services/contactKeys', () => ({ checkContactKeys: vi.fn() }));
vi.mock('../services/keyStore', () => ({ loadEncryptionKey: vi.fn() }));
vi.mock('./voiceClient', () => ({
  getVoiceSnapshot: vi.fn(() => ({ callId: null })),
  joinCall: vi.fn(async () => {}),
  leaveVoice: vi.fn(async () => {}),
  setVoiceError: vi.fn(),
}));
vi.mock('./ringtone', () => ({ startTone: vi.fn(), stopTone: vi.fn() }));

import { acceptCall, getCallSnapshot, hangUp, initCalls, startCall } from './callClient';
import { acceptCallRequest, hangUpRequest, startCallRequest } from '../services/callService';
import { fetchUsersList } from '../services/dmService';
import { checkContactKeys } from '../services/contactKeys';
import { loadEncryptionKey } from '../services/keyStore';
import { getVoiceSnapshot, joinCall, leaveVoice, setVoiceError } from './voiceClient';
import { startTone } from './ringtone';
import {
  generateUserKeys,
  importEncryptionPrivateKey,
} from '../services/encryptionService';

const emit = (event) => events.listeners.forEach((cb) => cb(event));
const flush = () => new Promise((r) => setTimeout(r, 0));

// Two real people with real keys: what one encrypts, the other must open.
let alice;
let bob;
beforeEach(async () => {
  vi.clearAllMocks();
  const [aliceKeys, bobKeys] = [await generateUserKeys(), await generateUserKeys()];
  const row = (id, username, keys) => ({ id, username, encryption_key: keys.public.encryptionKey });
  alice = { id: 1, username: 'alice', keys: aliceKeys, row: row(1, 'alice', aliceKeys) };
  bob = { id: 2, username: 'bob', keys: bobKeys, row: row(2, 'bob', bobKeys) };
  checkContactKeys.mockImplementation(async (_me, contact) => ({ status: 'trusted', encryptionKey: contact.encryption_key }));
});

async function as(person) {
  loadEncryptionKey.mockResolvedValue(await importEncryptionPrivateKey(person.keys.private.encryptionKey));
  initCalls({ id: person.id, username: person.username });
  await flush();
}

describe('callClient', () => {
  it('sends an encrypted key that the person called opens to the same key', async () => {
    await as(alice);
    await startCall(bob.row);
    expect(startTone).toHaveBeenCalledWith('ringback');
    const [calleeId, callId, envelope] = startCallRequest.mock.calls[0];
    expect(calleeId).toBe(2);
    expect(envelope).toMatch(/^v1\./);
    const callerKey = joinCall.mock.calls[0][0].key;
    expect(joinCall.mock.calls[0][0]).toMatchObject({ callId, url: 'wss://lk', token: 'caller-token' });
    expect(getCallSnapshot().call).toMatchObject({ id: callId, peerId: 2, outgoing: true, state: 'ringing' });

    // Bob's side.
    joinCall.mockClear();
    await as(bob);
    fetchUsersList.mockResolvedValue([alice.row]);
    emit({ type: 'call_incoming', call: { id: callId, caller_id: 1, caller_username: 'alice', key_envelope: envelope, state: 'ringing' } });
    expect(getCallSnapshot().call).toMatchObject({ id: callId, peerName: 'alice', outgoing: false, state: 'ringing' });
    expect(startTone).toHaveBeenCalledWith('incoming');
    await acceptCall();
    expect(acceptCallRequest).toHaveBeenCalledWith(callId);
    expect(joinCall.mock.calls[0][0].key).toEqual(callerKey);
    expect(getCallSnapshot().call).toMatchObject({ state: 'active', answeredAt: 1234 });
  });

  it("won't call someone whose key changed", async () => {
    await as(alice);
    checkContactKeys.mockResolvedValue({ status: 'changed', encryptionKey: null });
    await startCall(bob.row);
    expect(joinCall).not.toHaveBeenCalled();
    expect(getCallSnapshot().call).toBeNull();
    expect(setVoiceError).toHaveBeenCalledWith("bob's security key changed. Open your chat with them to review it.");
  });

  it('stops ringing when another of my devices answers', async () => {
    await as(bob);
    emit({ type: 'call_incoming', call: { id: 'c1', caller_id: 1, caller_username: 'alice', key_envelope: 'v1.x', state: 'ringing' } });
    emit({ type: 'call_update', call: { id: 'c1', state: 'active', answered_at: 5 } });
    expect(getCallSnapshot().call).toBeNull();
  });

  it('tells the caller why it ended, after leaving', async () => {
    await as(alice);
    await startCall(bob.row);
    const { id } = getCallSnapshot().call;
    getVoiceSnapshot.mockReturnValue({ callId: id });
    emit({ type: 'call_end', id, reason: 'declined' });
    await flush();
    expect(leaveVoice).toHaveBeenCalled();
    expect(setVoiceError).toHaveBeenCalledWith('bob declined the call.');
    expect(getCallSnapshot().call).toBeNull();
  });

  it('hangs up', async () => {
    await as(alice);
    await startCall(bob.row);
    const { id } = getCallSnapshot().call;
    await hangUp();
    expect(hangUpRequest).toHaveBeenCalledWith(id);
    expect(getCallSnapshot().call).toBeNull();
  });
});
