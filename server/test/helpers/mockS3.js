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
// Unfinished multipart uploads, by upload id: { bucket, key, contentType, parts: Map<number, size> }.
// Tests "put" a part with putMockPart, as the client would to its signed URL.
export const multipartUploads = new Map();
// Every part URL the server signed: { key, uploadId, partNumber, contentLength }.
export const signedParts = [];
export const abortedUploads = [];
let nextUploadId = 1;
export function putMockPart(uploadId, partNumber, size) {
  multipartUploads.get(uploadId).parts.set(partNumber, size);
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
    startMultipartUpload: async (bucket, key, contentType) => {
      const uploadId = `upload-${nextUploadId++}`;
      multipartUploads.set(uploadId, { bucket, key, contentType, parts: new Map() });
      return uploadId;
    },
    getUploadPartUrl: async (bucket, key, uploadId, partNumber, contentLength) => {
      signedParts.push({ key, uploadId, partNumber, contentLength });
      return `https://mock-s3.test/${bucket}/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
    },
    listUploadedParts: async (bucket, key, uploadId) => [...multipartUploads.get(uploadId).parts]
      .map(([PartNumber, Size]) => ({ PartNumber, Size, ETag: `"etag-${PartNumber}"` }))
      .sort((a, b) => a.PartNumber - b.PartNumber),
    completeMultipartUpload: async (bucket, key, uploadId, parts) => {
      const size = parts.reduce((sum, p) => sum + multipartUploads.get(uploadId).parts.get(p.PartNumber), 0);
      objects.set(`${bucket}/${key}`, { body: Buffer.alloc(0), size, contentType: multipartUploads.get(uploadId).contentType });
      multipartUploads.delete(uploadId);
    },
    abortMultipartUpload: async (bucket, key, uploadId) => {
      abortedUploads.push({ key, uploadId });
      multipartUploads.delete(uploadId);
    },
    listTopLevelKeys: async (bucket) => [...objects.keys()]
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1))
      .filter((k) => !k.includes('/')),
  },
};
