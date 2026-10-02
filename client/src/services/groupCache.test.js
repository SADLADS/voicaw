import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { forgetGroup, forgetGroups, recallGroup, rememberGroup, rememberGroupName } from './groupCache';
import { generateGroupKey, importGroupKey } from './groupCrypto';

const GROUP = '11111111-2222-4333-8444-555555555555';
const name = (text, version) => ({ name: text, version, signed: { record: new Uint8Array([1]), signature: new Uint8Array([2]) } });

describe('groupCache', () => {
  beforeEach(() => forgetGroups());

  it('keeps epoch keys usable, adds new ones, and keeps the newer name', async () => {
    const key1 = await importGroupKey(generateGroupKey());
    const key2 = await importGroupKey(generateGroupKey());
    await rememberGroup(7, GROUP, { keys: new Map([[1, key1]]), identityKeys: new Map([[7, 'id7']]), members: [{ id: 7, name: 'me' }], name: name('Trip', 2) });
    await rememberGroup(7, GROUP, { keys: new Map([[2, key2]]), identityKeys: new Map([[7, 'id7']]), name: name('Older', 1) });

    const saved = await recallGroup(7, GROUP);
    expect(Object.keys(saved.epochs)).toEqual(['1', '2']);
    expect(saved.epochs[1].extractable).toBe(false);
    const iv = new Uint8Array(12);
    await expect(crypto.subtle.encrypt({ name: 'AES-GCM', iv }, saved.epochs[2], new Uint8Array([1]))).resolves.toBeTruthy();
    expect(saved.members).toEqual([{ id: 7, name: 'me' }]);
    expect(saved.name).toMatchObject({ name: 'Trip', version: 2 });

    await rememberGroupName(7, GROUP, name('Plans', 3));
    expect((await recallGroup(7, GROUP)).name).toMatchObject({ name: 'Plans', version: 3 });
  });

  it("is only another account's after logging in as it, and goes when forgotten", async () => {
    await rememberGroup(7, GROUP, { keys: new Map(), identityKeys: new Map(), members: [], name: null });
    expect(await recallGroup(8, GROUP)).toBeNull();
    await forgetGroup(GROUP);
    expect(await recallGroup(7, GROUP)).toBeNull();
  });
});
