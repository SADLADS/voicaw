// The real s3.js opens a network connection to S3_ENDPOINT at require-time
// (bucket creation/policy calls) and there's no MinIO test double, so we
// pre-seed Node's CJS require cache before index.js ever requires it.
//
// vi.mock doesn't help here: index.js and s3.js are plain CommonJS modules
// loaded via Node's native `require`, which Vitest's ESM-oriented mock graph
// does not intercept.
const s3Path = require.resolve('../../s3.js');

require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    s3: {},
    getUploadUrl: async (filename, bucket) => `https://mock-s3.test/${bucket}/${filename}?signed=1`,
    getDownloadUrl: async (filename) => `https://mock-s3.test/uploads/${filename}?signed=1`,
  },
};
