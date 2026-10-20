import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({ default: { post: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ closeWebSocket: vi.fn(), SUSPENDED_NOTICE: 'suspendedNotice' }));
vi.mock('../voice/voiceClient', () => ({ leaveVoice: vi.fn(async () => {}) }));
vi.mock('../voice/callClient', () => ({ hangUp: vi.fn(async () => {}) }));
vi.mock('./keyStore', () => ({ clearUserKeys: vi.fn(async () => {}) }));
vi.mock('./groupCache', () => ({ forgetGroups: vi.fn(async () => {}) }));
vi.mock('./pushService', () => ({ disableNotificationsOnThisDevice: vi.fn(async () => {}) }));
vi.mock('./draftStore', () => ({ clearDrafts: vi.fn() }));
vi.mock('./searchIndex', () => ({ clearSearchIndex: vi.fn(async () => {}) }));
vi.mock('./offlineCopy', () => ({ clearOfflineCopy: vi.fn(async () => {}) }));

const api = (await import('../utils/api')).default;
const { closeWebSocket } = await import('../utils/ws-client');
const { hangUp } = await import('../voice/callClient');
const { clearUserKeys } = await import('./keyStore');
const { disableNotificationsOnThisDevice } = await import('./pushService');
const { clearSearchIndex } = await import('./searchIndex');
const { clearOfflineCopy } = await import('./offlineCopy');
const { LOGOUT_SERVER_MS, forgetLogin, logOut } = await import('./logout');

const never = () => new Promise(() => {});

function storage(entries) {
  const store = new Map(entries);
  return {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage([['token', 'tok']]));
  vi.stubGlobal('sessionStorage', storage([]));
  // Earlier tests' never-answering servers.
  disableNotificationsOnThisDevice.mockImplementation(async () => {});
  hangUp.mockImplementation(async () => {});
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

describe('logOut twice', () => {
  // Ending the session tells this device's own socket, which logs out again.
  it('runs once when asked again meanwhile', async () => {
    api.post.mockResolvedValue({});
    await Promise.all([logOut(), logOut()]);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(clearUserKeys).toHaveBeenCalledTimes(1);
  });

  it('leaves a new login alone', async () => {
    let answer;
    api.post.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const out = logOut();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    // Logged in again before the server answered.
    localStorage.setItem('token', 'new');
    answer({});
    await out;
    expect(localStorage.getItem('token')).toBe('new');
    expect(clearUserKeys).not.toHaveBeenCalled();
  });
});

describe('forgetLogin', () => {
  it('asks the server nothing', async () => {
    await forgetLogin();
    expect(api.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearUserKeys).toHaveBeenCalled();
  });

  it("forgets everything stored for the account, but keeps this device's settings", async () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('guildChannel:5', '12');
    localStorage.setItem('lastChat', '/dm/7');
    localStorage.setItem('taskCollapsed:3', '[]');
    localStorage.setItem('recoveryPromptDismissed', '1');
    sessionStorage.setItem('something', 'x');
    sessionStorage.setItem('suspendedNotice', '{"reason":null}');
    await forgetLogin();
    expect(clearSearchIndex).toHaveBeenCalled();
    expect(clearOfflineCopy).toHaveBeenCalled();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(localStorage.getItem('guildChannel:5')).toBeNull();
    expect(localStorage.getItem('lastChat')).toBeNull();
    expect(localStorage.getItem('taskCollapsed:3')).toBeNull();
    expect(localStorage.getItem('recoveryPromptDismissed')).toBeNull();
    expect(sessionStorage.getItem('something')).toBeNull();
    // The login page says why an account was suspended, after this logout.
    expect(sessionStorage.getItem('suspendedNotice')).toBe('{"reason":null}');
  });

  it('clears the rest when one part fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clearUserKeys.mockRejectedValueOnce(new Error('blocked'));
    await forgetLogin();
    expect(clearOfflineCopy).toHaveBeenCalled();
    expect(clearSearchIndex).toHaveBeenCalled();
  });
});
