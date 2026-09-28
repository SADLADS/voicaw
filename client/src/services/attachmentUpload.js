import api from '../utils/api';
import { encryptAttachment, buildAttachmentUrl, ENCRYPTION_OVERHEAD_BYTES } from './attachmentCrypto';

// media.voicaw.com's nginx vhost caps request bodies at 100M (client_max_body_size).
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024 - ENCRYPTION_OVERHEAD_BYTES;

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

// Encrypts `file`, uploads the ciphertext and returns the attachment URL to embed in the
// message (upload URL + decryption key/metadata in the fragment). `dimensions` is the
// media's { width, height } when known.
export async function uploadAttachment(file, onProgress, dimensions = null) {
  const { blob, key } = await encryptAttachment(file);

  // Ask for an opaque binary upload so the object's content type doesn't leak what it is.
  const { data } = await api.get('/upload_file', { params: { type: blob.type } });
  if (!data?.uploadUrl || !data?.fileUrl) throw new Error('Invalid upload URL');

  await putWithProgress(data.uploadUrl, blob, onProgress);

  return buildAttachmentUrl(data.fileUrl, {
    key,
    type: file.type || 'application/octet-stream',
    size: file.size,
    width: dimensions?.width,
    height: dimensions?.height,
  });
}
