// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Android app: no web push; Android's permission, and a Firebase token for the server.
const state = { permission: 'prompt', fullScreen: true, push: true };
vi.mock('../utils/android', () => ({
  isAndroidApp: () => true,
  androidNotificationState: () => state,
  requestAndroidNotifications: vi.fn(async () => { state.permission = 'granted'; return 'granted'; }),
  androidSubscription: vi.fn(async () => ({ endpoint: 'fcm:phone-token', fcm: { token: 'phone-token', key: 'KEY' } })),
  setAndroidLoggedOut: vi.fn(async () => {}),
}));
vi.mock('../utils/api', () => ({ default: { post: vi.fn(async () => ({ data: {} })) } }));

import api from '../utils/api';
import { requestAndroidNotifications, setAndroidLoggedOut } from '../utils/android';
import { disableNotificationsOnThisDevice, enableNotifications, ensureSubscription, getPushStatus } from './pushService';

beforeEach(() => {
  Object.assign(state, { permission: 'prompt', push: true });
  localStorage.clear();
  vi.clearAllMocks();
});

describe('notifications in the Android app', () => {
  it("follows Android's permission, and says when the build can't push", () => {
    expect(getPushStatus()).toBe('can-enable');
    state.permission = 'granted';
    expect(getPushStatus()).toBe('granted');
    localStorage.setItem('pushDisabled', '1');
    expect(getPushStatus()).toBe('off');
    state.permission = 'denied';
    expect(getPushStatus()).toBe('denied');
    state.push = false;
    expect(getPushStatus()).toBe('unsupported');
  });

  it("asks Android, then registers the phone's token and key", async () => {
    localStorage.setItem('pushDisabled', '1');
    expect(await enableNotifications()).toBe('granted');
    expect(requestAndroidNotifications).toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/save-subscription', {
      subscription: { endpoint: 'fcm:phone-token', fcm: { token: 'phone-token', key: 'KEY' } },
    });
    expect(localStorage.getItem('pushDisabled')).toBeNull();
  });

  it('registers without a VAPID key', async () => {
    await ensureSubscription(undefined);
    expect(api.post).toHaveBeenCalledWith('/save-subscription', expect.anything());
  });

  // A logout set it (forgetLogin); the token registered for this login, pushes show again.
  it('lets the phone show pushes again once its token is registered', async () => {
    await ensureSubscription(undefined);
    expect(setAndroidLoggedOut).toHaveBeenCalledWith(false);
  });

  it("doesn't if the server didn't take the token", async () => {
    api.post.mockRejectedValueOnce(new Error('Network Error'));
    await expect(ensureSubscription(undefined)).rejects.toThrow();
    expect(setAndroidLoggedOut).not.toHaveBeenCalled();
  });

  it('tells the server to forget the phone when turned off', async () => {
    await disableNotificationsOnThisDevice({ remember: true });
    expect(api.post).toHaveBeenCalledWith('/delete-subscription', { endpoint: 'fcm:phone-token' });
    expect(localStorage.getItem('pushDisabled')).toBe('1');
  });
});
