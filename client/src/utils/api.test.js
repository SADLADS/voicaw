// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import api from './api';
import { setOfflineMode } from './offlineMode';
import { clearOfflineCopy, loadDoc } from '../services/offlineCopy';

// Runs a request through the real interceptors, with a stand-in for the network that can do
// something (log out, log in as someone else) while the request is out.
function requestWith(headers, meanwhile = () => {}) {
  return api.get('/profile', {
    adapter: async (config) => {
      meanwhile();
      return { data: {}, status: 200, statusText: 'OK', headers, config };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'old');
});

describe('api token renewal', () => {
  it('stores a renewed token', async () => {
    await requestWith({ 'x-voicaw-token': 'new' });
    expect(localStorage.getItem('token')).toBe('new');
  });

  it('leaves the token alone without one', async () => {
    await requestWith({});
    expect(localStorage.getItem('token')).toBe('old');
  });

  it('does not bring a token back after logging out', async () => {
    await requestWith({ 'x-voicaw-token': 'new' }, () => localStorage.removeItem('token'));
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('ignores a renewal of a different login', async () => {
    await requestWith({ 'x-voicaw-token': 'new' }, () => localStorage.setItem('token', 'second'));
    expect(localStorage.getItem('token')).toBe('second');
  });
});

describe('the login cookie', () => {
  const login = { id: 7, username: 'a', sid: 'S1', iat: 1 };
  const sent = async (setup) => {
    let seen;
    await api.get('/profile', { ...setup, adapter: async (config) => { seen = config; return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; } });
    return seen;
  };

  it('names the session and sends the cookie, with no Authorization', async () => {
    localStorage.clear();
    localStorage.setItem('login', JSON.stringify(login));
    const config = await sent();
    expect(config.headers['X-Voicaw-Session']).toBe('S1');
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.withCredentials).toBe(true);
  });

  it('logged out, asks for the cookie when logging in', async () => {
    localStorage.clear();
    const config = await sent();
    expect(config.headers['X-Voicaw-Login']).toBe('cookie');
    expect(config.withCredentials).toBe(true);
  });

  it('a 409 login_changed reloads onto the newer login another tab saved, only then', async () => {
    const { onLoginReplaced } = await import('./loginToken');
    const replaced = vi.fn();
    const stop = onLoginReplaced(replaced);
    const refuse = (meanwhile) => api.get('/profile', {
      adapter: async (config) => {
        meanwhile();
        const err = new Error('409');
        err.config = config;
        err.response = { status: 409, data: { error: 'Another login replaced this one', code: 'login_changed' }, config };
        throw err;
      },
    }).catch(() => {});
    try {
      localStorage.clear();
      localStorage.setItem('login', JSON.stringify(login));
      await refuse(() => {});
      expect(replaced).not.toHaveBeenCalled();
      await refuse(() => localStorage.setItem('login', JSON.stringify({ ...login, sid: 'S2' })));
      expect(replaced).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe('api login token', () => {
  async function sentToken(config = {}) {
    let sent;
    await api.get('/x', {
      ...config,
      adapter: async (c) => {
        sent = c.headers.Authorization;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config: c };
      },
    });
    return sent;
  }

  it('sends the saved token', async () => {
    expect(await sentToken()).toBe('Bearer old');
  });

  // Logout's last requests, sent after logging in again, must not end the new session.
  it('keeps a token the request names', async () => {
    localStorage.setItem('token', 'second');
    expect(await sentToken({ headers: { Authorization: 'Bearer old' } })).toBe('Bearer old');
  });
});

describe('api and the offline copy', () => {
  // A login token for account `id` (only its payload is read on the device).
  const tokenFor = (id) => `h.${btoa(JSON.stringify({ id, sid: 's' })).replace(/=+$/, '')}.sig`;
  const answering = (data) => async (config) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
  const unreachable = async (config) => { throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK', config }); };
  const proxyDown = async (config) => {
    throw Object.assign(new Error('Bad Gateway'), { config, response: { status: 502, data: '', headers: {}, config } });
  };
  const refused = async (config) => {
    throw Object.assign(new Error('Forbidden'), { config, response: { status: 403, data: {}, headers: {}, config } });
  };

  beforeEach(async () => {
    localStorage.setItem('token', tokenFor(7));
    setOfflineMode(false);
    await clearOfflineCopy();
  });

  // The answer is saved after the response, in the background.
  const saved = (name, account = 7) => vi.waitFor(async () => {
    const data = await loadDoc(account, name);
    if (data === undefined) throw new Error('not saved yet');
    return data;
  });

  it("saves the lists' answers for the account, and gives them back offline only", async () => {
    await api.get('/dms-list', { adapter: answering([{ id: 2 }]) });
    expect(await saved('/dms-list')).toEqual([{ id: 2 }]);
    // Online, a failure is a failure.
    await expect(api.get('/dms-list', { adapter: unreachable })).rejects.toThrow('Network Error');
    setOfflineMode(true);
    const res = await api.get('/dms-list', { adapter: unreachable });
    expect(res.data).toEqual([{ id: 2 }]);
    expect(res.fromOfflineCopy).toBe(true);
    // The proxy saying the API is down counts as out of reach too.
    expect((await api.get('/dms-list', { adapter: proxyDown })).data).toEqual([{ id: 2 }]);
  });

  it('never stands in for a server that refuses', async () => {
    await api.get('/profile', { adapter: answering({ id: 7 }) });
    await saved('/profile');
    setOfflineMode(true);
    await expect(api.get('/profile', { adapter: refused })).rejects.toThrow('Forbidden');
  });

  it("starts offline mode from the first /profile, and 'never' always asks the server", async () => {
    await api.get('/profile', { adapter: answering({ id: 7 }) });
    await saved('/profile');
    expect((await api.get('/profile', { adapter: unreachable, offlineCopy: 'fallback' })).data).toEqual({ id: 7 });
    setOfflineMode(true);
    await expect(api.get('/profile', { adapter: unreachable, offlineCopy: 'never' })).rejects.toThrow('Network Error');
  });

  it("keeps only the lists, never another account's or after logging out", async () => {
    await api.get('/guilds', { adapter: answering([{ id: 1 }]) });
    await api.get('/dm-messages/2', { adapter: answering([{ id: 1 }]) });
    await api.get('/profile', { adapter: async (config) => { localStorage.removeItem('token'); return answering({ id: 7 })(config); } });
    await api.get('/dms-list', { adapter: answering([{ id: 3 }]) }); // no token: nothing sent as anyone
    localStorage.setItem('token', tokenFor(8));
    await api.get('/friends', { adapter: answering([{ id: 4 }]) });
    await saved('/friends', 8);
    expect(await loadDoc(7, '/guilds')).toBeUndefined();
    expect(await loadDoc(7, '/dm-messages/2')).toBeUndefined();
    expect(await loadDoc(7, '/profile')).toBeUndefined();
    expect(await loadDoc(7, '/friends')).toBeUndefined();
  });
});
