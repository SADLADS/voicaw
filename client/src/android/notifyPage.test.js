// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/pushNotifications', () => ({
  notificationFromPush: vi.fn(async (payload) => ({
    title: 'Sam',
    options: { body: 'decrypted preview', tag: payload.tag, icon: '/logo192.png', data: { url: '/dm/5' } },
  })),
}));
vi.mock('../services/callService', () => ({ declineCallRequest: vi.fn(async () => {}) }));

import { declineCallRequest } from '../services/callService';

// The app's side of the hidden page: what it calls, and what it gets back.
const results = [];
beforeAll(async () => {
  window.VoicawNotifyHost = { ready: vi.fn(), result: (id, json) => results.push([id, JSON.parse(json)]) };
  await import('./notifyPage');
});

describe("the Android app's notification page", () => {
  it('says it is ready', () => {
    expect(window.VoicawNotifyHost.ready).toHaveBeenCalled();
  });

  it('words a notification as the service worker would', async () => {
    await window.voicawNotify.run(1, { type: 'render', payload: { type: 'dm', tag: 'dm-5' } });
    expect(results.at(-1)).toEqual([1, {
      ok: true, title: 'Sam', body: 'decrypted preview', tag: 'dm-5', url: '/dm/5',
      icon: `${location.origin}/logo192.png`,
      labels: { answer: 'Accept', decline: 'Decline', incomingCall: 'Incoming voice call', groupCall: 'Group call' },
    }]);
  });

  it('declines a call, and reports failures', async () => {
    await window.voicawNotify.run(2, { type: 'decline', callId: 'call-1' });
    expect(declineCallRequest).toHaveBeenCalledWith('call-1');
    expect(results.at(-1)).toEqual([2, { ok: true }]);
    declineCallRequest.mockRejectedValueOnce(new Error('offline'));
    await window.voicawNotify.run(3, { type: 'decline', callId: 'call-2' });
    expect(results.at(-1)).toEqual([3, { ok: false, error: 'offline' }]);
  });
});
