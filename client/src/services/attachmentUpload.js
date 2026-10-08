import api from '../utils/api';
import { buildAttachmentUrl } from './attachmentCrypto';
import { chunkedEncryptor, encryptedSize, CHUNK_SIZE, TAG_BYTES } from './chunkedAttachment';
import { t } from '../i18n';

// The biggest file anyone may send unless the server says otherwise (/api/config
// maxUploadBytes, Settings → Admin's File size limit).
export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
// Up to this much ciphertext goes in one request; more goes in parts (the server's
// PART_BYTES each), a few at a time, so only those parts are ever in memory.
const SINGLE_UPLOAD_BYTES = 16 * 1024 * 1024;
const PARALLEL_PARTS = 3;
const PART_ATTEMPTS = 3;

// The most `limit` (the server's maxUploadBytes) lets through, leaving room for the
// encryption's overhead (16 bytes per 256 KiB: 32 KB at 500 MB).
export function maxAttachmentBytes(limit = DEFAULT_MAX_UPLOAD_BYTES) {
  return Math.floor(limit / (CHUNK_SIZE + TAG_BYTES)) * CHUNK_SIZE;
}

// PUTs `body` to `url`; `onProgress(bytes)` hears how much of it has gone.
function putWithProgress(url, body, type, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if (type) xhr.setRequestHeader('Content-Type', type);

    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(t('media.upload.failedStatus', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('media.upload.failed')));
    xhr.send(body);
  });
}

// Uploads an encrypted blob in one request and resolves to its URL.
async function putEncrypted(blob, onProgress) {
  // Ask for an opaque binary upload so the object's content type doesn't leak what it is.
  // The size is signed into the upload URL; the storage server rejects any other length.
  const { data } = await api.get('/upload_file', { params: { type: blob.type, size: blob.size } });
  if (!data?.uploadUrl || !data?.fileUrl) throw new Error(t('media.upload.invalidUrl'));
  await putWithProgress(data.uploadUrl, blob, blob.type, onProgress);
  return data.fileUrl;
}

// Encrypts and uploads a big file in parts (the server's multipart routes), each part the
// ciphertext of a run of whole chunks, PARALLEL_PARTS at a time. A part that fails is tried
// again; if it still fails, the upload is abandoned. Resolves to the file's URL.
async function putInParts(encryptor, onProgress) {
  const total = encryptedSize(encryptor.size);
  const { data } = await api.post('/upload_file/multipart', { type: 'application/octet-stream', size: total });
  const { name, fileUrl, partSize, partCount } = data ?? {};
  const stride = CHUNK_SIZE + TAG_BYTES;
  if (!name || !fileUrl || !partSize || partSize % stride) throw new Error(t('media.upload.invalidUrl'));
  const chunksPerPart = partSize / stride;
  const sent = new Array(partCount).fill(0);
  const report = () => onProgress?.(sent.reduce((a, b) => a + b, 0));

  async function sendPart(index) {
    const first = index * chunksPerPart;
    const body = await encryptor.encrypt(first, Math.min(encryptor.count, first + chunksPerPart) - 1);
    for (let attempt = 1; ; attempt++) {
      try {
        const { data: part } = await api.post(`/upload_file/multipart/${name}/parts/${index + 1}`);
        await putWithProgress(part.url, body, null, (bytes) => {
          sent[index] = bytes;
          report();
        });
        sent[index] = body.length;
        report();
        return;
      } catch (err) {
        sent[index] = 0;
        report();
        if (attempt >= PART_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < partCount) await sendPart(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, partCount) }, worker));
    await api.post(`/upload_file/multipart/${name}/complete`);
  } catch (err) {
    next = partCount; // the other workers stop after their part
    api.delete(`/upload_file/multipart/${name}`).catch(() => {});
    throw err;
  }
  return fileUrl;
}

// Encrypts `file` (in 256 KiB chunks, chunkedAttachment.js: v2), uploads the ciphertext and
// returns the attachment URL to embed in the message (upload URL + decryption key/metadata in
// the fragment). `onProgress(bytes)` hears how much has been sent. `info` is what's known of
// the media: { width, height }, for a video { duration, poster (a JPEG Blob) }, and for a big
// image { thumbnail (a Blob) }; `spoiler` marks it as a spoiler. The file itself is sent as it
// is.
export async function uploadAttachment(file, onProgress, info = null, spoiler = false) {
  const type = file.type || 'application/octet-stream';
  const encryptor = await chunkedEncryptor(file);
  const still = info?.poster ?? info?.thumbnail;
  const posterUrl = still ? await putEncrypted(await encryptor.poster(still)) : null;
  const fileUrl = encryptedSize(file.size) <= SINGLE_UPLOAD_BYTES
    ? await putEncrypted(
      new Blob([await encryptor.encrypt(0, encryptor.count - 1)], { type: 'application/octet-stream' }),
      onProgress,
    )
    : await putInParts(encryptor, onProgress);
  return buildAttachmentUrl(fileUrl, {
    type,
    size: file.size,
    width: info?.width,
    height: info?.height,
    spoiler,
    key: encryptor.key,
    nonce: encryptor.nonce,
    duration: info?.duration,
    poster: posterUrl?.split('/').pop(),
  });
}
