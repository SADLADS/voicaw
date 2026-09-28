// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/api', () => ({ default: { post: vi.fn(async () => ({ data: { sent: 1 } })) } }));

import api from '../utils/api';
import {
  getPushStatus,
  ensureSubscription,
  enableNotifications,
  disableNotificationsOnThisDevice,
} from './pushService';

// A VAPID public key (base64url) and its bytes.
const VAPID = 'BAECAwQ';
const VAPID_BYTES = [4, 1, 2, 3, 4];

let calls;
let subscription;
let registration;

function fakeSubscription(endpoint, keyBytes) {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array(keyBytes).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => { calls.push('unsubscribe'); subscription = null; return true; }),
  };
}

function setUserAgent(ua, { standalone = false } = {}) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
  window.matchMedia = () => ({ matches: standalone });
}

function installPushSupport({ permission = 'default' } = {}) {
  window.PushManager = function PushManager() {};
  registration = {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async ({ applicationServerKey }) => {
        calls.push('subscribe');
        subscription = fakeSubscription('https://push.test/new', [...applicationServerKey]);
        return subscription;
      }),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      get ready() { calls.push('serviceWorker.ready'); return Promise.resolve(registration); },
      getRegistration: async () => registration,
    },
  });
  window.Notification = {
    permission,
    requestPermission: vi.fn(async () => { calls.push('requestPermission'); window.Notification.permission = 'granted'; return 'granted'; }),
  };
}

function removePushSupport() {
  delete window.PushManager;
  delete window.Notification;
  delete navigator.serviceWorker;
}

beforeEach(() => {
  calls = [];
  subscription = null;
  localStorage.clear();
  vi.clearAllMocks();
  setUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/140');
});

afterEach(() => {
  removePushSupport();
});

describe('getPushStatus', () => {
  it('tells iPhone users in Safari they need the Home Screen app', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    expect(getPushStatus()).toBe('needs-install');
  });

  it('reports unsupported browsers', () => {
    expect(getPushStatus()).toBe('unsupported');
  });

  it('works in the installed iPhone app', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', { standalone: true });
    installPushSupport();
    expect(getPushStatus()).toBe('can-enable');
  });

  it('reflects the browser permission and the in-app off switch', () => {
    installPushSupport({ permission: 'granted' });
    expect(getPushStatus()).toBe('granted');
    localStorage.setItem('pushDisabled', '1');
    expect(getPushStatus()).toBe('off');
    window.Notification.permission = 'denied';
    expect(getPushStatus()).toBe('denied');
  });
});

describe('ensureSubscription', () => {
  it('re-sends an existing subscription for our key without re-subscribing', async () => {
    installPushSupport({ permission: 'granted' });
    subscription = fakeSubscription('https://push.test/existing', VAPID_BYTES);

    await ensureSubscription(VAPID);

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/save-subscription', {
      subscription: { endpoint: 'https://push.test/existing', keys: { p256dh: 'p', auth: 'a' } },
    });
  });

  it('replaces a subscription made for a different server key', async () => {
    installPushSupport({ permission: 'granted' });
    subscription = fakeSubscription('https://push.test/old-key', [9, 9, 9]);

    await ensureSubscription(VAPID);

    expect(calls).toEqual(['serviceWorker.ready', 'unsubscribe', 'subscribe']);
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(VAPID_BYTES),
    });
    expect(api.post.mock.calls[0][1].subscription.endpoint).toBe('https://push.test/new');
  });
});

describe('push service failures', () => {
  it('explains "push service error" (e.g. Brave with Google push off) instead of the raw error', async () => {
    installPushSupport({ permission: 'granted' });
    registration.pushManager.subscribe = vi.fn(async () => {
      throw Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' });
    });

    await expect(ensureSubscription(VAPID)).rejects.toThrow(/Brave/);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('passes other subscribe errors through unchanged', async () => {
    installPushSupport({ permission: 'granted' });
    registration.pushManager.subscribe = vi.fn(async () => { throw new Error('something else'); });

    await expect(ensureSubscription(VAPID)).rejects.toThrow('something else');
  });
});

describe('enableNotifications', () => {
  it('asks for permission before anything else, so iOS counts it as user-initiated', async () => {
    installPushSupport();

    expect(await enableNotifications(VAPID)).toBe('granted');

    expect(calls[0]).toBe('requestPermission');
    expect(calls).toContain('subscribe');
    expect(api.post).toHaveBeenCalledWith('/save-subscription', expect.anything());
  });

  it('does not subscribe when the user says no', async () => {
    installPushSupport();
    window.Notification.requestPermission = vi.fn(async () => 'denied');

    expect(await enableNotifications(VAPID)).toBe('denied');

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('clears a previous in-app "off"', async () => {
    installPushSupport();
    localStorage.setItem('pushDisabled', '1');

    await enableNotifications(VAPID);

    expect(getPushStatus()).toBe('granted');
  });
});

describe('disableNotificationsOnThisDevice', () => {
  it('tells the server to forget this device, then unsubscribes', async () => {
    installPushSupport({ permission: 'granted' });
    subscription = fakeSubscription('https://push.test/mine', VAPID_BYTES);
    const unsubscribe = subscription.unsubscribe;

    await disableNotificationsOnThisDevice();

    expect(api.post).toHaveBeenCalledWith('/delete-subscription', { endpoint: 'https://push.test/mine' });
    expect(unsubscribe).toHaveBeenCalled();
    expect(getPushStatus()).toBe('granted'); // logout: the next user on this device can get them
  });

  it('remembers the choice when the user turns notifications off', async () => {
    installPushSupport({ permission: 'granted' });
    subscription = fakeSubscription('https://push.test/mine', VAPID_BYTES);

    await disableNotificationsOnThisDevice({ remember: true });

    expect(getPushStatus()).toBe('off');
  });
});
