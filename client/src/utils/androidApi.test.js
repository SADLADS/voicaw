import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

const apiRequest = vi.fn();
vi.mock('./android', () => ({ android: { apiRequest: (...args) => apiRequest(...args), forgetApiLogin: vi.fn(async () => {}) } }));
vi.mock('./server', () => ({ apiBaseUrl: () => 'https://app.voicaw.com/api/' }));

const { nativeAdapter, hasNativeApi } = await import('./androidApi');

const api = axios.create({ baseURL: 'https://app.voicaw.com/api/', adapter: nativeAdapter });
const sent = () => JSON.parse(apiRequest.mock.calls.at(-1)[0].request);
const answer = (status, body, headers = { 'content-type': 'application/json' }) => apiRequest.mockResolvedValue({ status, statusText: '', headers, body: JSON.stringify(body) });

beforeEach(() => {
  apiRequest.mockReset();
});

describe('the Android app making the requests (androidApi)', () => {
  it('is there in the Android app', () => {
    expect(hasNativeApi()).toBe(true);
  });

  it("sends the request as the page made it, naming its session, and parses the answer", async () => {
    answer(200, { id: 7 });
    const res = await api.post('/dm-calls/c1/decline', { why: 'busy' }, { headers: { 'X-Voicaw-Session': 'S1' }, params: { a: 1 }, timeout: 5000 });
    expect(res.data).toEqual({ id: 7 });
    expect(res.status).toBe(200);
    const request = sent();
    expect(request).toMatchObject({ method: 'POST', url: 'https://app.voicaw.com/api/dm-calls/c1/decline?a=1', body: '{"why":"busy"}', timeout: 5000 });
    expect(request.headers['X-Voicaw-Session']).toBe('S1');
    expect(request.headers['Content-Type']).toMatch(/application\/json/);
    expect(request.headers['User-Agent']).toBe(navigator.userAgent);
    // The page never has a token to send.
    expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('turns a refusal into an axios error with the response, as the browser would', async () => {
    answer(401, { error: 'Not logged in', code: 'no_session' });
    const err = await api.get('/profile').catch((e) => e);
    expect(err.isAxiosError).toBe(true);
    expect(err.response.status).toBe(401);
    expect(err.response.data).toEqual({ error: 'Not logged in', code: 'no_session' });
  });

  it('out of reach: no response (offline); too slow: a timeout', async () => {
    apiRequest.mockResolvedValue({ error: 'network' });
    const offline = await api.get('/profile').catch((e) => e);
    expect(offline.response).toBeUndefined();
    expect(offline.code).toBe('ERR_NETWORK');
    apiRequest.mockResolvedValue({ error: 'timeout' });
    const slow = await api.get('/profile', { timeout: 10 }).catch((e) => e);
    expect(slow.code).toBe('ECONNABORTED');
  });

  it('sends FormData as the bytes and type a browser would', async () => {
    answer(200, {});
    const form = new FormData();
    form.append('payload_json', '{"x":1}');
    form.append('files[0]', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    await api.post('/channels/1/command-interactions', form);
    const request = sent();
    expect(request.body).toBeUndefined();
    const type = request.headers['Content-Type'];
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    const text = atob(request.bodyBase64);
    expect(text).toContain('name="payload_json"');
    expect(text).toContain('filename="a.txt"');
    expect(text).toContain('hello');
  });

  it('a cancelled request stops waiting', async () => {
    apiRequest.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const waiting = api.get('/profile', { signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect(axios.isCancel(await waiting)).toBe(true);
  });
});

describe('the hidden notification page (VoicawNotifyHost)', () => {
  it('asks the host and takes its answer back', async () => {
    vi.resetModules();
    vi.doMock('./android', () => ({ android: null }));
    vi.doMock('./server', () => ({ apiBaseUrl: () => 'https://app.voicaw.com/api/' }));
    const asked = [];
    globalThis.window = { VoicawNotifyHost: { apiRequest: (id, json) => asked.push({ id, request: JSON.parse(json) }) } };
    const fresh = await import('./androidApi');
    expect(fresh.hasNativeApi()).toBe(true);
    const notifyApi = axios.create({ baseURL: 'https://app.voicaw.com/api/', adapter: fresh.nativeAdapter });
    const reply = notifyApi.post('/dm-calls/c1/decline', null, { headers: { 'X-Voicaw-Session': 'S1' } });
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0].request).toMatchObject({ method: 'POST', url: 'https://app.voicaw.com/api/dm-calls/c1/decline' });
    fresh.answerFromNotifyHost(asked[0].id, JSON.stringify({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }));
    expect((await reply).data).toEqual({ ok: true });
    delete globalThis.window;
  });
});
