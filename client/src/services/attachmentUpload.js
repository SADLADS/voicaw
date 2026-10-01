import api from '../utils/api';
import { encryptAttachment, buildAttachmentUrl, isStreamable } from './attachmentCrypto';
import { encryptChunkedAttachment } from './chunkedAttachment';

// media.voicaw.com's nginx vhost caps request bodies at 100M (client_max_body_size). Leaves
// room for the encryption's overhead (a video's is 16 bytes per 256 KiB: 6.4 KB at 100 MB).
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024 - 8 * 1024;

function putWithProgress(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', blob.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(blob);
  });
}

// Uploads an encrypted blob and resolves to its URL.
async function putEncrypted(blob, onProgress) {
  // Ask for an opaque binary upload so the object's content type doesn't leak what it is.
  // The size is signed into the upload URL; the storage server rejects any other length.
  const { data } = await api.get('/upload_file', { params: { type: blob.type, size: blob.size } });
  if (!data?.uploadUrl || !data?.fileUrl) throw new Error('Invalid upload URL');
  await putWithProgress(data.uploadUrl, blob, onProgress);
  return data.fileUrl;
}

// Encrypts `file`, uploads the ciphertext and returns the attachment URL to embed in the
// message (upload URL + decryption key/metadata in the fragment). `info` is what's known of
// the media: { width, height } and, for a video, { duration, poster (a JPEG Blob) };
// `spoiler` marks it as a spoiler.
export async function uploadAttachment(file, onProgress, info = null, spoiler = false) {
  const type = file.type || 'application/octet-stream';
  const fields = { type, size: file.size, width: info?.width, height: info?.height, spoiler };

  if (isStreamable(type)) {
    const { blob, key, nonce, poster } = await encryptChunkedAttachment(file, info?.poster);
    const posterUrl = poster ? await putEncrypted(poster) : null;
    const fileUrl = await putEncrypted(blob, onProgress);
    return buildAttachmentUrl(fileUrl, {
      ...fields,
      key,
      nonce,
      duration: info?.duration,
      poster: posterUrl?.split('/').pop(),
    });
  }

  const { blob, key } = await encryptAttachment(file);
  const fileUrl = await putEncrypted(blob, onProgress);
  return buildAttachmentUrl(fileUrl, { ...fields, key });
}
