// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const BUILT_IN_API = import.meta.env.VITE_API_BASE_URL;

// server.js reads the saved choice once, at load (the page reloads onto a new one).
async function load(saved) {
  vi.resetModules();
  if (saved) localStorage.setItem('server', JSON.stringify(saved));
  else localStorage.removeItem('server');
  return import('./server');
}

const answering = (body, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }));
const VOICAW_CONFIG = { signupMode: 'open', termsVersion: '2026-10-05' };

beforeEach(() => localStorage.clear());

describe('apiUrlFromInput', () => {
  it('makes the API address from a host, a URL or a path', async () => {
    const { apiUrlFromInput } = await load();
    expect(apiUrlFromInput('chat.example.com')).toBe('https://chat.example.com/api/');
    expect(apiUrlFromInput('  https://chat.example.com/  ')).toBe('https://chat.example.com/api/');
    expect(apiUrlFromInput('https://chat.example.com/api')).toBe('https://chat.example.com/api/');
    expect(apiUrlFromInput('example.com/voicaw/')).toBe('https://example.com/voicaw/api/');
    expect(apiUrlFromInput('http://localhost:3005')).toBe('http://localhost:3005/api/');
  });

  it('refuses what is not a web address', async () => {
    const { apiUrlFromInput } = await load();
    for (const input of ['', '   ', 'ftp://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://']) {
      expect(apiUrlFromInput(input)).toBeNull();
    }
  });
});

describe('findServer', () => {
  it("checks the server's config and takes its websocket, else /api/socket", async () => {
    const { findServer } = await load();
    const plain = answering(VOICAW_CONFIG);
    expect(await findServer('chat.example.com', { fetchImpl: plain })).toEqual({
      api: 'https://chat.example.com/api/', ws: 'wss://chat.example.com/api/socket', host: 'chat.example.com',
    });
    expect(plain.mock.calls[0][0]).toBe('https://chat.example.com/api/config');

    const named = answering({ ...VOICAW_CONFIG, websocketUrl: 'wss://ws.example.com' });
    expect((await findServer('chat.example.com', { fetchImpl: named })).ws).toBe('wss://ws.example.com/');
    const bad = answering({ ...VOICAW_CONFIG, websocketUrl: 'https://not-a-socket.example.com' });
    expect((await findServer('chat.example.com', { fetchImpl: bad })).ws).toBe('wss://chat.example.com/api/socket');
  });

  it('says why when there is no Voicaw server there', async () => {
    const { findServer } = await load();
    await expect(findServer('ftp://x', { fetchImpl: answering(VOICAW_CONFIG) })).rejects.toMatchObject({ code: 'invalid_address' });
    await expect(findServer('example.com', { fetchImpl: answering({}, false) })).rejects.toMatchObject({ code: 'unreachable' });
    await expect(findServer('example.com', { fetchImpl: answering({ hello: 'world' }) })).rejects.toMatchObject({ code: 'unreachable' });
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(findServer('example.com', { fetchImpl: down })).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('the chosen server', () => {
  it('is the built-in one until another is saved, and keeps stored data apart', async () => {
    const builtIn = await load();
    expect(builtIn.apiBaseUrl()).toBe(BUILT_IN_API);
    expect(builtIn.isBuiltInServer()).toBe(true);
    expect(builtIn.serverSuffix()).toBe('');

    await builtIn.saveServer({ api: 'https://chat.example.com/api/', ws: 'wss://chat.example.com/api/socket' });
    const other = await load(JSON.parse(localStorage.getItem('server')));
    expect(other.apiBaseUrl()).toBe('https://chat.example.com/api/');
    expect(other.websocketUrl()).toBe('wss://chat.example.com/api/socket');
    expect(other.isBuiltInServer()).toBe(false);
    expect(other.serverSuffix()).toBe('@chat.example.com');
    expect(await other.serverSuffixAnywhere()).toBe('@chat.example.com');
  });

  it('saves the built-in server, typed in again, as no choice', async () => {
    const { saveServer } = await load({ api: 'https://chat.example.com/api/', ws: 'wss://chat.example.com/' });
    await saveServer({ api: new URL(BUILT_IN_API, location.href).href, ws: 'wss://whatever/' });
    expect(localStorage.getItem('server')).toBeNull();
  });

  it('ignores a saved choice that is not a server', async () => {
    const { apiBaseUrl } = await load({ api: 'javascript:alert(1)', ws: 'wss://x/' });
    expect(apiBaseUrl()).toBe(BUILT_IN_API);
  });
});
