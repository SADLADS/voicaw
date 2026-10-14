import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({ default: { post: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ closeWebSocket: vi.fn() }));
vi.mock('../voice/voiceClient', () => ({ leaveVoice: vi.fn(async () => {}) }));
vi.mock('../voice/callClient', () => ({ hangUp: vi.fn(async () => {}) }));
vi.mock('./keyStore', () => ({ clearUserKeys: vi.fn(async () => {}) }));
vi.mock('./groupCache', () => ({ forgetGroups: vi.fn(async () => {}) }));
vi.mock('./pushService', () => ({ disableNotificationsOnThisDevice: vi.fn(async () => {}) }));
vi.mock('./draftStore', () => ({ clearDrafts: vi.fn() }));
vi.mock('./searchIndex', () => ({ clearSearchIndex: vi.fn(async () => {}) }));

const api = (await import('../utils/api')).default;
const { closeWebSocket } = await import('../utils/ws-client');
const { hangUp } = await import('../voice/callClient');
const { clearUserKeys } = await import('./keyStore');
const { disableNotificationsOnThisDevice } = await import('./pushService');
const { LOGOUT_SERVER_MS, forgetLogin, logOut } = await import('./logout');

const never = () => new Promise(() => {});

beforeEach(() => {
  const store = new Map([['token', 'tok']]);
  vi.stubGlobal('localStorage', {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('logOut', () => {
  it('ends the session on the server, then forgets the login', async () => {
    api.post.mockResolvedValue({});
    await logOut();
    expect(disableNotificationsOnThisDevice).toHaveBeenCalledWith({ timeout: LOGOUT_SERVER_MS, token: 'tok' });
    expect(api.post).toHaveBeenCalledWith('/logout', null, { headers: { Authorization: 'Bearer tok' } });
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
    expect(closeWebSocket).toHaveBeenCalled();
  });

  it('forgets the login when the server refuses connections', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await logOut();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it("doesn't wait more than LOGOUT_SERVER_MS for a server that doesn't answer", async () => {
    vi.useFakeTimers();
    disableNotificationsOnThisDevice.mockImplementation(never);
    hangUp.mockImplementation(never);
    api.post.mockImplementation(never);
    let done = false;
    logOut().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(LOGOUT_SERVER_MS - 1);
    expect(done).toBe(false);
    expect(localStorage.getItem('token')).toBe('tok');
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
  });
});

describe('forgetLogin', () => {
  it('asks the server nothing', async () => {
    await forgetLogin();
    expect(api.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
  });
});
