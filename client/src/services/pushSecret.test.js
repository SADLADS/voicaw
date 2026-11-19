import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map();
let failWrites = false;
vi.mock('./settingsStore', () => ({
  getSetting: vi.fn(async (name) => store.get(name)),
  setSetting: vi.fn(async (name, value) => {
    if (failWrites) throw new Error('no IndexedDB');
    store.set(name, value);
  }),
}));

const { pushUpdateSecret, savedPushUpdateSecret, forgetPushUpdateSecret } = await import('./pushSecret');

describe('push update secret', () => {
  beforeEach(() => {
    store.clear();
    failWrites = false;
  });

  it('is made once, kept for the service worker, and forgotten at logout', async () => {
    expect(await savedPushUpdateSecret()).toBeNull();
    const secret = await pushUpdateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pushUpdateSecret()).toBe(secret);
    expect(await savedPushUpdateSecret()).toBe(secret);

    await forgetPushUpdateSecret();
    expect(await savedPushUpdateSecret()).toBeNull();
    const next = await pushUpdateSecret();
    expect(next).not.toBe(secret);
  });

  it("isn't sent when it can't be stored", async () => {
    failWrites = true;
    expect(await pushUpdateSecret()).toBeNull();
  });
});
