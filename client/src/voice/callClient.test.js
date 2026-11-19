import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({ listeners: new Set(), group: new Set() }));
const voice = vi.hoisted(() => ({ listeners: new Set() }));
vi.mock('../utils/ws-client', () => ({
  onCallEvent: (cb) => {
    events.listeners.add(cb);
    return () => events.listeners.delete(cb);
  },
  onGroupEvent: (cb) => {
    events.group.add(cb);
    return () => events.group.delete(cb);
  },
}));
vi.mock('../services/groupKeys', async (importOriginal) => ({ ...(await importOriginal()), openGroup: vi.fn(), currentEpoch: vi.fn() }));
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
  onVoiceChange: (cb) => {
    voice.listeners.add(cb);
    return () => voice.listeners.delete(cb);
  },
  setVoiceError: vi.fn(),
}));
vi.mock('../sounds/sounds', () => ({ startLoop: vi.fn(), stopLoop: vi.fn(), playSound: vi.fn() }));

import {
  acceptCall, answerWhenRinging, declineCall, getCallSnapshot, hangUp, initCalls, noteGroupCall, startCall,
} from './callClient';
import { acceptCallRequest, declineCallRequest, fetchCurrentCall, hangUpRequest, startCallRequest } from '../services/callService';
import { catchUp } from '../utils/catchUp';
import { fetchUsersList } from '../services/dmService';
import { checkContactKeys } from '../services/contactKeys';
import { loadEncryptionKey } from '../services/keyStore';
import { getVoiceSnapshot, joinCall, leaveVoice, setVoiceError } from './voiceClient';
import { startLoop } from '../sounds/sounds';
import { openGroup } from '../services/groupKeys';
import {
  callKeySignatureContext, encryptGroupCallKey, generateGroupKey, groupCallKeyContext, importGroupKey,
} from '../services/groupCrypto';
import { importIdentityPrivateKey } from '../services/encryptionService';
import { t } from '../i18n';
import {
  callKeyContext,
  deriveConversationKey,
  encryptCallKey,
  generateCallKey,
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
    expect(startLoop).toHaveBeenCalledWith('outgoingRing');
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
    expect(startLoop).toHaveBeenCalledWith('incomingRing');
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

  it("times the call by this device's clock, even when it's behind the server's", async () => {
    await as(alice);
    await startCall(bob.row);
    const { id } = getCallSnapshot().call;
    const serverNow = Date.now() + 5 * 60 * 1000;
    emit({ type: 'call_update', call: { id, state: 'active', answered_at: serverNow - 2000, server_now: serverNow } });
    const { answeredAt } = getCallSnapshot().call;
    expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(2000);
    expect(Date.now() - answeredAt).toBeLessThan(3000);
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

  // The page asleep with a dead socket: nothing below reached it as an event.
  describe('catching up with the server', () => {
    const ringing = (id = 'c1') => ({ id, group_id: null, caller_id: 1, caller_username: 'alice', callee_id: 2, key_envelope: 'v1.x', state: 'ringing', ringing: [2] });

    it('shows a call that started while it was asleep', async () => {
      await as(bob);
      fetchCurrentCall.mockResolvedValueOnce(ringing());
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toMatchObject({ id: 'c1', outgoing: false, state: 'ringing' });
    });

    it('drops a ringing call that ended while it was asleep', async () => {
      await as(bob);
      emit({ type: 'call_incoming', call: ringing() });
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toBeNull();
    });

    it('keeps a call still ringing', async () => {
      await as(bob);
      emit({ type: 'call_incoming', call: ringing() });
      fetchCurrentCall.mockResolvedValueOnce(ringing());
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toMatchObject({ id: 'c1', state: 'ringing' });
    });

    it("doesn't drop a call that started while it was asking", async () => {
      await as(bob);
      let answer;
      fetchCurrentCall.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
      catchUp();
      emit({ type: 'call_incoming', call: ringing() });
      answer(null);
      await flush();
      expect(getCallSnapshot().call).toMatchObject({ id: 'c1', state: 'ringing' });
    });

    it("doesn't bring back a call declined while it was asking", async () => {
      await as(bob);
      emit({ type: 'call_incoming', call: ringing() });
      let answer;
      fetchCurrentCall.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
      catchUp();
      await declineCall();
      answer(ringing());
      await flush();
      expect(getCallSnapshot().call).toBeNull();
    });

    it('moves the caller on when the call was answered while asleep', async () => {
      await as(alice);
      await startCall(bob.row);
      const { id } = getCallSnapshot().call;
      getVoiceSnapshot.mockReturnValue({ callId: id });
      fetchCurrentCall.mockResolvedValueOnce({ id, group_id: null, state: 'active', answered_at: 5 });
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toMatchObject({ id, state: 'active' });
    });

    it("leaves a call the server forgot while still in its room (an API restart)", async () => {
      await as(alice);
      await startCall(bob.row);
      const { id } = getCallSnapshot().call;
      getVoiceSnapshot.mockReturnValue({ callId: id });
      emit({ type: 'call_update', call: { id, state: 'active', answered_at: 5 } });
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toMatchObject({ id, state: 'active' });
    });

    it('ends a call that has gone, room and all', async () => {
      await as(alice);
      await startCall(bob.row);
      const { id } = getCallSnapshot().call;
      emit({ type: 'call_update', call: { id, state: 'active', answered_at: 5 } });
      catchUp();
      await flush();
      expect(getCallSnapshot().call).toBeNull();
    });

    it("checks at once when the call's room closes, without waiting for the app to come back", async () => {
      await as(alice);
      await startCall(bob.row);
      const { id } = getCallSnapshot().call;
      getVoiceSnapshot.mockReturnValue({ callId: id });
      voice.listeners.forEach((cb) => cb());
      emit({ type: 'call_update', call: { id, state: 'active', answered_at: 5 } });
      getVoiceSnapshot.mockReturnValue({ callId: null });
      voice.listeners.forEach((cb) => cb());
      await flush();
      expect(getCallSnapshot().call).toBeNull();
    });

    it("doesn't end a call still being placed", async () => {
      await as(alice);
      let placed;
      startCallRequest.mockReturnValueOnce(new Promise((resolve) => { placed = resolve; }));
      const starting = startCall(bob.row);
      catchUp();
      await flush();
      await flush();
      const { id } = getCallSnapshot().call;
      expect(id).toBeTruthy();
      placed({ url: 'wss://lk', token: 't' });
      await starting;
      expect(joinCall).toHaveBeenCalled();
    });
  });

  describe('Answer on the notification', () => {
    const offer = async (id) => {
      const key = generateCallKey();
      const envelope = await encryptCallKey(key, await deriveConversationKey(await importEncryptionPrivateKey(alice.keys.private.encryptionKey), bob.keys.public.encryptionKey), callKeyContext(id, 1, 2));
      return { id, group_id: null, caller_id: 1, caller_username: 'alice', callee_id: 2, key_envelope: envelope, state: 'ringing', ringing: [2] };
    };

    it('answers a call this page never heard of, asking the server', async () => {
      await as(bob);
      fetchUsersList.mockResolvedValue([alice.row]);
      fetchCurrentCall.mockResolvedValueOnce(await offer('c1'));
      await answerWhenRinging('c1');
      expect(acceptCallRequest).toHaveBeenCalledWith('c1');
      expect(joinCall).toHaveBeenCalled();
    });

    it('keeps trying while the server is out of reach', async () => {
      await as(bob);
      fetchUsersList.mockResolvedValue([alice.row]);
      fetchCurrentCall.mockRejectedValueOnce(new Error('offline'));
      fetchCurrentCall.mockResolvedValueOnce(await offer('c1'));
      await answerWhenRinging('c1');
      expect(acceptCallRequest).toHaveBeenCalledWith('c1');
    });

    it('says so when the call has already ended', async () => {
      await as(bob);
      await answerWhenRinging('c1');
      expect(acceptCallRequest).not.toHaveBeenCalled();
      expect(setVoiceError).toHaveBeenCalledWith('That call has already ended.');
    });

    it('does nothing more for a call already being answered', async () => {
      await as(bob);
      fetchUsersList.mockResolvedValue([alice.row]);
      emit({ type: 'call_incoming', call: await offer('c1') });
      await Promise.all([answerWhenRinging('c1'), answerWhenRinging('c1')]);
      expect(acceptCallRequest).toHaveBeenCalledTimes(1);
      expect(setVoiceError).not.toHaveBeenCalled();
    });
  });

  describe('answering going wrong', () => {
    const offer = { id: 'c1', group_id: null, caller_id: 1, caller_username: 'alice', callee_id: 2, key_envelope: 'v1.x', state: 'ringing', ringing: [2] };

    it("doesn't hang up a call another device answered first", async () => {
      await as(bob);
      fetchUsersList.mockResolvedValue([alice.row]);
      const key = generateCallKey();
      const conversation = await deriveConversationKey(await importEncryptionPrivateKey(alice.keys.private.encryptionKey), bob.keys.public.encryptionKey);
      emit({ type: 'call_incoming', call: { ...offer, key_envelope: await encryptCallKey(key, conversation, callKeyContext('c1', 1, 2)) } });
      acceptCallRequest.mockRejectedValueOnce(Object.assign(new Error('Already answered'), { response: { status: 409, data: { error: 'Already answered' } } }));
      await acceptCall();
      expect(acceptCallRequest).toHaveBeenCalledWith('c1');
      expect(declineCallRequest).toHaveBeenCalledWith('c1');
      expect(hangUpRequest).not.toHaveBeenCalled();
      expect(setVoiceError).toHaveBeenCalledWith('Already answered');
    });

    it("leaves the call when its room can't be joined", async () => {
      await as(alice);
      joinCall.mockResolvedValueOnce(false);
      await startCall(bob.row);
      expect(getCallSnapshot().call).toBeNull();
      expect(hangUpRequest).toHaveBeenCalled();
    });

    it('stays in the call when joining was only overtaken', async () => {
      await as(alice);
      joinCall.mockResolvedValueOnce(undefined);
      await startCall(bob.row);
      expect(getCallSnapshot().call).not.toBeNull();
      expect(hangUpRequest).not.toHaveBeenCalled();
    });
  });

  describe('group calls', () => {
    const groupId = 'g1';
    // A group of alice (1), bob (2) and carol (3) as openGroup gives it: epoch 1 made by alice
    // after log entry `logSeq` for `holders`, with `members` in it now.
    async function groupCall({ holders = [1, 2, 3], members = [1, 2, 3], callerId = 1, logSeq = 2 } = {}) {
      const epochKey = await importGroupKey(generateGroupKey());
      const callKey = generateCallKey();
      const identity = await importIdentityPrivateKey(alice.keys.private.identityKey);
      const call = {
        id: 'gc1', group_id: groupId, caller_id: callerId, caller_username: 'alice', key_epoch: 1, participants: [callerId], ringing: [2],
        key_envelope: await encryptGroupCallKey(
          callKey, epochKey, groupCallKeyContext('gc1', groupId, 1, callerId), identity,
          callKeySignatureContext({ callId: 'gc1', groupId, epoch: 1, callerId })
        ),
      };
      const membersAt = [];
      membersAt[logSeq] = new Set(holders);
      openGroup.mockResolvedValue({
        keys: new Map([[1, epochKey]]),
        epochs: new Map([[1, { logSeq, creatorId: 1 }]]),
        log: {
          members: new Map(members.map((id) => [id, `ik${id}`])),
          identityKeys: new Map([[1, alice.keys.public.identityKey]]),
          membersAt,
          nextSeq: logSeq + 1,
        },
      });
      acceptCallRequest.mockResolvedValueOnce({ call: { ...call, participants: [1, 2] }, url: 'wss://lk', token: 'bob-token' });
      return { call, callKey };
    }

    async function answer(call) {
      await as(bob);
      emit({ type: 'call_incoming', call });
      await acceptCall();
    }

    it('joins with the key the caller signed, made for the members there are now', async () => {
      const { call, callKey } = await groupCall();
      await answer(call);
      expect(joinCall.mock.calls[0][0]).toMatchObject({ callId: 'gc1', key: callKey });
      expect(getCallSnapshot().call).toMatchObject({ id: 'gc1', groupId, state: 'active' });
    });

    it('still joins after someone was added (they never had the key)', async () => {
      const { call } = await groupCall({ holders: [1, 2], members: [1, 2, 3] });
      await answer(call);
      expect(joinCall).toHaveBeenCalled();
    });

    it("won't join a call whose key someone who has left the group holds", async () => {
      const { call } = await groupCall({ holders: [1, 2, 3], members: [1, 2] });
      await answer(call);
      expect(joinCall).not.toHaveBeenCalled();
      expect(acceptCallRequest).not.toHaveBeenCalled();
      expect(setVoiceError).toHaveBeenCalledWith(t('calls.errors.notPrivate'));
      expect(getCallSnapshot().call).toBeNull();
    });

    it("won't join a call from someone who isn't in the group now", async () => {
      const { call } = await groupCall({ holders: [1, 2], members: [2, 3] });
      await answer(call);
      expect(joinCall).not.toHaveBeenCalled();
      expect(setVoiceError).toHaveBeenCalledWith(t('calls.errors.unverified'));
    });

    it('leaves when someone leaves or is removed from the group during the call, not when someone joins', async () => {
      const { call } = await groupCall();
      await answer(call);
      getVoiceSnapshot.mockReturnValue({ callId: 'gc1' });
      const entry = (type) => ({ type: 'group_dm_update', group: { id: groupId }, entry: { seq: 3, record: JSON.stringify({ type }), signature: 's' } });
      events.group.forEach((cb) => cb(entry('add')));
      events.group.forEach((cb) => cb({ ...entry('leave'), group: { id: 'another' } }));
      await flush();
      expect(getCallSnapshot().call).not.toBeNull();
      events.group.forEach((cb) => cb(entry('remove')));
      await flush();
      expect(getCallSnapshot().call).toBeNull();
      expect(leaveVoice).toHaveBeenCalled();
      expect(hangUpRequest).toHaveBeenCalledWith('gc1');
      expect(setVoiceError).toHaveBeenCalledWith(t('calls.errors.memberLeft'));
      getVoiceSnapshot.mockReturnValue({ callId: null });
    });

    it("doesn't bring back a call that has ended from a group fetched before that", async () => {
      await as(bob);
      const call = { id: 'gc9', group_id: groupId, caller_id: 1, participants: [1, 2], ringing: [] };
      emit({ type: 'call_update', call });
      expect(getCallSnapshot().groupCalls[groupId]).toMatchObject({ id: 'gc9' });
      emit({ type: 'call_end', id: 'gc9', reason: 'ended' });
      expect(getCallSnapshot().groupCalls[groupId]).toBeUndefined();
      noteGroupCall(groupId, call);
      emit({ type: 'call_update', call });
      expect(getCallSnapshot().groupCalls[groupId]).toBeUndefined();
      noteGroupCall(groupId, { ...call, id: 'gc10' });
      expect(getCallSnapshot().groupCalls[groupId]).toMatchObject({ id: 'gc10' });
    });

    it('hangs up and says why when someone sends audio or video that isn\'t encrypted', async () => {
      const { call } = await groupCall();
      await answer(call);
      getVoiceSnapshot.mockReturnValue({ callId: 'gc1' });
      await joinCall.mock.calls[0][0].onUnencrypted();
      expect(getCallSnapshot().call).toBeNull();
      expect(leaveVoice).toHaveBeenCalled();
      expect(hangUpRequest).toHaveBeenCalledWith('gc1');
      expect(setVoiceError).toHaveBeenCalledWith(t('calls.errors.unencrypted'));
      getVoiceSnapshot.mockReturnValue({ callId: null });
    });
  });
});
