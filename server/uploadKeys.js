// The uploads a piece of text shows: every `<S3_ENDPOINT>/uploads/<name>` in it, plus a video's
// poster (`p=<name>` in an encrypted attachment's fragment, a name in the same folder; see
// services/attachmentCrypto.js in the client). Names only, without the bucket. No database
// here: migrations use it too.
const { s3Endpoint } = require('./config');

const escaped = `${s3Endpoint}/uploads/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const URL_RE = new RegExp(`${escaped}([A-Za-z0-9._/-]+)(#[^\\s)"'\\]<>]*)?`, 'g');
const POSTER_RE = /^[A-Za-z0-9_-]+\.bin$/;

function uploadKeysIn(text) {
  const keys = new Set();
  if (typeof text !== 'string' || !s3Endpoint) return keys;
  for (const [, key, fragment] of text.matchAll(URL_RE)) {
    keys.add(key);
    const poster = fragment && new URLSearchParams(fragment.slice(1)).get('p');
    if (poster && POSTER_RE.test(poster)) keys.add(key.replace(/[^/]*$/, poster));
  }
  return keys;
}

module.exports = { uploadKeysIn };
