// The real s3.js opens a network connection to S3_ENDPOINT at require-time
// (bucket creation/policy calls) and there's no MinIO test double, so we
// pre-seed Node's CJS require cache before index.js ever requires it.
//
// vi.mock doesn't help here: index.js and s3.js are plain CommonJS modules
// loaded via Node's native `require`, which Vitest's ESM-oriented mock graph
// does not intercept.
const s3Path = require.resolve('../../s3.js');

// Every pre-signed upload the server asked for (to check the size it signed).
export const signedUploads = [];
// Every object the server deleted.
export const deletedObjects = [];
// Keys ("bucket/key") whose delete fails, as if the store were down.
export const failingDeletes = new Set();
// The store's contents, by "bucket/key" ({ body, contentType }). Tests put uploads here.
export const objects = new Map();
export function putMockObject(bucket, key, body, contentType = 'application/octet-stream') {
  objects.set(`${bucket}/${key}`, { body, contentType });
}

require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    s3: {},
    getUploadUrl: async (filename, bucket, contentType, contentLength) => {
      signedUploads.push({ filename, bucket, contentType, contentLength });
      return `https://mock-s3.test/${bucket}/${filename}?signed=1`;
    },
    deleteObject: async (bucket, key) => {
      if (failingDeletes.has(`${bucket}/${key}`)) return false;
      deletedObjects.push({ bucket, key });
      objects.delete(`${bucket}/${key}`);
      return true;
    },
    getObject: async (bucket, key) => {
      const object = objects.get(`${bucket}/${key}`);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return object.body;
    },
    putObject: async (bucket, key, body, contentType) => {
      objects.set(`${bucket}/${key}`, { body, contentType });
    },
    listTopLevelKeys: async (bucket) => [...objects.keys()]
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1))
      .filter((k) => !k.includes('/')),
  },
};
