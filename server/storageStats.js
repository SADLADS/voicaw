// How full the object store is, for Settings → Admin → Storage (routes/admin.js). Read from
// MinIO's Prometheus metrics over the network (so it works wherever the store runs), with a
// token signed by the store's own credentials, as `mc admin prometheus generate` makes. MinIO's
// free space is its drive's (statfs), so files put there outside MinIO count too; it re-reads
// the drive about once a minute, and bucket usage comes from its scanner, a few minutes behind.
// Stores without these metrics (AWS S3, R2...) have no "space left": the panel says so.
const jwt = require('jsonwebtoken');

const BUCKETS = ['uploads', 'profile-pics', 'guild-icons', 'emojis'];
const CACHE_MS = 30 * 1000;
const TIMEOUT_MS = 5000;

let cached = null; // { at, stats }

// Prometheus text → [{ name, labels, value }].
function parseMetrics(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    for (const [, key, value] of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[key] = value;
    const value = Number(m[3]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

async function fetchMetrics(path) {
  const token = jwt.sign({ sub: process.env.S3_ROOT_USER, iss: 'prometheus' }, process.env.S3_ROOT_PASSWORD, {
    algorithm: 'HS512', expiresIn: 60,
  });
  const res = await fetch(new URL(path, process.env.S3_ENDPOINT), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`metrics ${path}: ${res.status}`);
  return parseMetrics(await res.text());
}

// { available: true, total, free, buckets: [{ name, bytes, objects }], otherBuckets: { bytes,
// objects }, checkedAt } in bytes (total/free null if the store doesn't say), or
// { available: false, checkedAt }.
async function readStorageStats() {
  const checkedAt = Date.now();
  let metrics;
  try {
    // Bucket usage moved to its own endpoint in newer MinIO; older ones list it with the cluster.
    const [cluster, bucket] = await Promise.all([
      fetchMetrics('/minio/v2/metrics/cluster'),
      fetchMetrics('/minio/v2/metrics/bucket').catch(() => []),
    ]);
    metrics = [...cluster, ...bucket];
  } catch (err) {
    console.warn('Storage stats unavailable:', err.message);
    return { available: false, checkedAt };
  }
  // Cluster-wide figures are repeated per node in a cluster: the first will do.
  const first = (name) => metrics.find((m) => m.name === name)?.value ?? null;
  const usage = new Map();
  for (const m of metrics) {
    const name = m.labels.bucket;
    if (!name) continue;
    if (m.name === 'minio_bucket_usage_total_bytes') usage.set(name, { ...usage.get(name), bytes: m.value });
    if (m.name === 'minio_bucket_usage_object_total') usage.set(name, { ...usage.get(name), objects: m.value });
  }
  const buckets = BUCKETS.map((name) => ({ name, bytes: usage.get(name)?.bytes ?? 0, objects: usage.get(name)?.objects ?? 0 }));
  // Other projects' buckets on the same store.
  const otherBuckets = { bytes: 0, objects: 0 };
  for (const [name, u] of usage) {
    if (BUCKETS.includes(name)) continue;
    otherBuckets.bytes += u.bytes ?? 0;
    otherBuckets.objects += u.objects ?? 0;
  }
  return {
    available: true,
    total: first('minio_cluster_capacity_usable_total_bytes'),
    free: first('minio_cluster_capacity_usable_free_bytes'),
    buckets,
    otherBuckets,
    checkedAt,
  };
}

// Cached for half a minute (MinIO's own figures don't move faster); `fresh` asks again.
async function getStorageStats({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.stats;
  const stats = await readStorageStats();
  cached = { at: Date.now(), stats };
  return stats;
}

function clearCache() {
  cached = null;
}

module.exports = { getStorageStats, parseMetrics, clearCache, BUCKETS };
