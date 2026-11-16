import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setUpBuckets, BUCKETS } = require('../bucketSetup.js');

// A fake S3 client: `existing` buckets answer HeadBucket, `policies` says whether
// PutBucketPolicy works (MinIO) or answers NotImplemented (Garage), `fail` makes one bucket's
// HeadBucket throw something else.
function fakeStore({ existing = [], policies = true, fail = null } = {}) {
  const calls = [];
  const buckets = new Set(existing);
  const send = vi.fn(async (command) => {
    const name = command.constructor.name;
    const bucket = command.input.Bucket;
    calls.push([name, bucket]);
    if (name === 'HeadBucketCommand') {
      if (bucket === fail) throw Object.assign(new Error('boom'), { name: 'AccessDenied' });
      if (!buckets.has(bucket)) throw Object.assign(new Error('not found'), { name: 'NotFound' });
      return {};
    }
    if (name === 'CreateBucketCommand') { buckets.add(bucket); return {}; }
    if (name === 'PutBucketPolicyCommand') {
      if (!policies) throw Object.assign(new Error('Not implemented'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
      return {};
    }
    throw new Error(`unexpected ${name}`);
  });
  return { client: { send }, calls, buckets };
}

const quiet = () => ({ info: vi.fn(), error: vi.fn() });

describe('setUpBuckets', () => {
  it('creates missing buckets and makes each public on a store with policies', async () => {
    const store = fakeStore({ existing: ['uploads'] });
    const result = await setUpBuckets(store.client, { log: quiet() });
    expect(result).toEqual({ failed: [], policies: true });
    expect([...store.buckets].sort()).toEqual([...BUCKETS].sort());
    const policyCalls = store.calls.filter(([n]) => n === 'PutBucketPolicyCommand').map(([, b]) => b);
    expect(policyCalls).toEqual(BUCKETS);
    expect(store.calls).not.toContainEqual(['CreateBucketCommand', 'uploads']);
  });

  it('sets public-read for GetObject on the bucket only', async () => {
    const store = fakeStore();
    await setUpBuckets(store.client, { buckets: ['emojis'], log: quiet() });
    const put = store.client.send.mock.calls.map(([c]) => c).find((c) => c.constructor.name === 'PutBucketPolicyCommand');
    const policy = JSON.parse(put.input.Policy);
    expect(policy.Statement).toEqual([{
      Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::emojis/*'],
    }]);
  });

  it('on a store without bucket policies (Garage), still sets up every bucket and asks only once', async () => {
    const store = fakeStore({ policies: false });
    const log = quiet();
    const result = await setUpBuckets(store.client, { log });
    expect(result).toEqual({ failed: [], policies: false });
    expect([...store.buckets].sort()).toEqual([...BUCKETS].sort());
    expect(store.calls.filter(([n]) => n === 'PutBucketPolicyCommand')).toHaveLength(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a failing bucket is logged and the rest are still set up', async () => {
    const store = fakeStore({ fail: 'guild-icons' });
    const log = quiet();
    const result = await setUpBuckets(store.client, { log });
    expect(result.failed).toEqual(['guild-icons']);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(store.buckets.has('sounds')).toBe(true);
    expect(store.buckets.has('guild-icons')).toBe(false);
  });
});
