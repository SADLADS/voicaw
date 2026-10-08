import './helpers/mockS3.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const storageStats = require('../storageStats.js');

let userCount = 0;
async function makeUser({ admin = false } = {}) {
  const username = `storage-user-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-storage-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-storage-1');
  if (admin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [regRes.body.id]);
  return { id: regRes.body.id, token: loginRes.body.token };
}
const getStorage = (user, query = '') =>
  request(app).get(`/api/admin/storage${query}`).set({ Authorization: `Bearer ${user.token}` });

// What MinIO RELEASE.2025-07-23 answers (bucket usage on its own endpoint).
const CLUSTER = `# HELP minio_cluster_capacity_usable_free_bytes Total free usable capacity online in the cluster
# TYPE minio_cluster_capacity_usable_free_bytes gauge
minio_cluster_capacity_raw_free_bytes{server="127.0.0.1:9005"} 1.12493154304e+11
minio_cluster_capacity_usable_free_bytes{server="127.0.0.1:9005"} 1.12493154304e+11
minio_cluster_capacity_usable_total_bytes{server="127.0.0.1:9005"} 4.758418432e+11
minio_cluster_usage_total_bytes{server="127.0.0.1:9005"} 3.150728e+06
`;
const BUCKET = `minio_bucket_usage_object_total{bucket="emojis",server="127.0.0.1:9005"} 1
minio_bucket_usage_object_total{bucket="uploads",server="127.0.0.1:9005"} 12
minio_bucket_usage_total_bytes{bucket="emojis",server="127.0.0.1:9005"} 5000
minio_bucket_usage_total_bytes{bucket="uploads",server="127.0.0.1:9005"} 3.145728e+06
minio_bucket_usage_total_bytes{bucket="someone-else",server="127.0.0.1:9005"} 700
minio_bucket_usage_object_total{bucket="someone-else",server="127.0.0.1:9005"} 2
`;

let fetchMock;
function storeAnswers(answers) {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const body = answers[new URL(url).pathname];
    if (body == null) return new Response('', { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body, { status: 200 });
  });
}

beforeEach(() => storageStats.clearCache());
afterEach(() => vi.restoreAllMocks());

describe('GET /admin/storage', () => {
  it('is for admins only', async () => {
    storeAnswers({});
    const user = await makeUser();
    expect((await getStorage(user)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads MinIO's metrics with a token signed by the store's credentials", async () => {
    storeAnswers({ '/minio/v2/metrics/cluster': CLUSTER, '/minio/v2/metrics/bucket': BUCKET });
    const admin = await makeUser({ admin: true });
    const res = await getStorage(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      total: 475841843200,
      free: 112493154304,
      buckets: [
        { name: 'uploads', bytes: 3145728, objects: 12 },
        { name: 'profile-pics', bytes: 0, objects: 0 },
        { name: 'guild-icons', bytes: 0, objects: 0 },
        { name: 'emojis', bytes: 5000, objects: 1 },
      ],
      otherBuckets: { bytes: 700, objects: 2 },
    });
    expect(typeof res.body.checkedAt).toBe('number');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${process.env.S3_ENDPOINT}/minio/v2/metrics/cluster`);
    const token = init.headers.Authorization.replace(/^Bearer /, '');
    const claims = jwt.verify(token, process.env.S3_ROOT_PASSWORD, { algorithms: ['HS512'] });
    expect(claims).toMatchObject({ sub: process.env.S3_ROOT_USER, iss: 'prometheus' });
  });

  it('takes bucket usage from the cluster endpoint on older MinIO', async () => {
    storeAnswers({ '/minio/v2/metrics/cluster': CLUSTER + BUCKET });
    const admin = await makeUser({ admin: true });
    const res = await getStorage(admin);
    expect(res.body.available).toBe(true);
    expect(res.body.buckets[0]).toEqual({ name: 'uploads', bytes: 3145728, objects: 12 });
  });

  it('says unavailable for a store without the metrics', async () => {
    storeAnswers({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const admin = await makeUser({ admin: true });
    const res = await getStorage(admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, checkedAt: expect.any(Number) });
  });

  it('says unavailable when the store is down', async () => {
    storeAnswers({ '/minio/v2/metrics/cluster': new TypeError('fetch failed') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const admin = await makeUser({ admin: true });
    expect((await getStorage(admin)).body.available).toBe(false);
  });

  it('caches for half a minute unless asked fresh', async () => {
    storeAnswers({ '/minio/v2/metrics/cluster': CLUSTER, '/minio/v2/metrics/bucket': BUCKET });
    const admin = await makeUser({ admin: true });
    await getStorage(admin);
    await getStorage(admin);
    expect(fetchMock).toHaveBeenCalledTimes(2); // cluster + bucket, once
    await getStorage(admin, '?fresh=1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
