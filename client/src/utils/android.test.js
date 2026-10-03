import { describe, it, expect } from 'vitest';
import { isAndroidApp, ongoingNotification, sameOngoing } from './android';

const labels = { mute: 'Mute', unmute: 'Unmute', hangUp: 'Hang up' };

describe('the Android app bridge', () => {
  it('is only there in the app', () => {
    expect(isAndroidApp()).toBe(false);
  });

  it('shows an ongoing-call notification only while in voice', () => {
    expect(ongoingNotification({ status: 'idle' }, { title: 'x', status: 'y', labels })).toBeNull();
    expect(ongoingNotification({ status: 'connected', callId: 'c1', selfMute: false, selfDeaf: true }, { title: 'Call with Sam', status: 'Connected', labels }))
      .toEqual({ title: 'Call with Sam', text: 'Connected', muted: true, inCall: true, labels });
    expect(ongoingNotification({ status: 'connecting', callId: null }, { title: 'General', status: 'Connecting…', labels }))
      .toMatchObject({ inCall: false, muted: false });
  });

  it('only updates the notification when what it shows changes', () => {
    const a = { title: 'General', text: 'Connected', muted: false, inCall: false, labels };
    expect(sameOngoing(a, { ...a, labels: { ...labels } })).toBe(true);
    expect(sameOngoing(a, { ...a, muted: true })).toBe(false);
    expect(sameOngoing(null, null)).toBe(true);
    expect(sameOngoing(a, null)).toBe(false);
  });
});
