import { describe, it, expect, vi, afterEach } from 'vitest';
import { withOpaque } from './opaqueSession';

vi.mock('@serenity-kit/opaque', () => ({
  ready: Promise.resolve(),
  client: { startLogin: ({ password }) => ({ clientLoginState: 's', startLoginRequest: `r:${password}` }) },
}));

// A stand-in worker answering each call with its name and arguments.
class FakeWorker {
  static made = [];
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.terminated = false;
    FakeWorker.made.push(this);
  }
  postMessage({ id, name, args }) {
    setTimeout(() => this.onmessage({ data: name === 'finishLogin' ? { id, error: 'bad' } : { id, result: { name, args } } }));
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.made = [];
});

describe('withOpaque', () => {
  it('runs the exchange in a module worker of its own, ended once it has finished', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const result = await withOpaque(async (opaque) => {
      expect(FakeWorker.made[0].terminated).toBe(false);
      return opaque.startLogin({ password: 'pw' });
    });
    expect(result).toEqual({ name: 'startLogin', args: { password: 'pw' } });
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].url).toMatch(/opaqueWorker\.js/);
    expect(FakeWorker.made[0].options).toEqual({ type: 'module' });
    expect(FakeWorker.made[0].terminated).toBe(true);
  });

  it("passes the worker's errors on and still ends it when the exchange fails", async () => {
    vi.stubGlobal('Worker', FakeWorker);
    await expect(withOpaque((opaque) => opaque.finishLogin({}))).rejects.toThrow('bad');
    await expect(withOpaque(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(FakeWorker.made.map((w) => w.terminated)).toEqual([true, true]);
  });

  it('runs OPAQUE in the page where there are no workers', async () => {
    vi.stubGlobal('Worker', undefined);
    expect(await withOpaque((opaque) => opaque.startLogin({ password: 'pw' }))).toEqual({ clientLoginState: 's', startLoginRequest: 'r:pw' });
  });
});
