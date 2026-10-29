// Saving an encrypted attachment. A small one (or an old v1 one, which can only be decrypted
// whole) is downloaded, decrypted and kept as a blob: URL (attachmentCache.js), then saved. A
// big v2 one never is whole in the page: it's decrypted a chunk at a time as it downloads
// (chunkedAttachment.js decryptingStream) and each piece goes straight to the file:
// - the Android app: its Downloads folder (utils/android.js saveToDownloads);
// - the desktop app: where the person chooses in the Save dialog (electron/fileSave.js);
// - a browser: the service worker answers a hidden frame with the file as a download
//   (mediaStreamWorker.js), so the browser saves it as it arrives, with its own progress.
// Without any of them (a first visit, before the worker), it's the whole-file way after all.
import { loadDecryptedAttachment, getCachedAttachment } from './attachmentCache';
import { decryptingStream, importChunkKey, encryptedSize } from './chunkedAttachment';
import { canDownloadThroughWorker, streamUrl, streamStatus, releaseStream } from './videoStream';
import { triggerDownload } from '../utils/saveFile';
import { isAndroidApp, saveToDownloads, showAndroidToast } from '../utils/android';
import { desktop } from '../utils/desktop';
import { t } from '../i18n';

// From this size, a v2 file is saved as it downloads; smaller ones are kept decrypted (opened
// again at once) and show their progress in the app.
export const STREAM_SAVE_MIN_BYTES = 32 * 1024 * 1024;
// How long the page waits to hear the worker has begun the download (or failed).
const WORKER_START_MS = 15_000;

// The plaintext of `meta`'s file, as it downloads. `onProgress(fraction)` hears how far.
export async function decryptedFileStream(meta, onProgress) {
  const res = await fetch(meta.fileUrl);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = encryptedSize(meta.size);
  let received = 0;
  const counting = new TransformStream({
    transform(bytes, controller) {
      received += bytes.length;
      onProgress?.(Math.min(1, received / total));
      controller.enqueue(bytes);
    },
  });
  return res.body.pipeThrough(counting).pipeThrough(decryptingStream(await importChunkKey(meta.key), meta.nonce, meta.size));
}

async function saveInAndroidApp(meta, name, onProgress) {
  try {
    const notify = { title: name, body: t('media.save.notificationBody') };
    const { notified } = await saveToDownloads(await decryptedFileStream(meta, onProgress), name, { type: meta.type, notify });
    if (!notified) showAndroidToast(t('media.save.saved', { name }));
  } catch (err) {
    console.warn('Could not save the file', err);
    showAndroidToast(t('media.save.failed'));
  }
}

async function saveInDesktopApp(meta, name, onProgress) {
  const id = await desktop.saveFile.start(name);
  if (id == null) return; // cancelled
  try {
    const reader = (await decryptedFileStream(meta, onProgress)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await desktop.saveFile.append(id, value);
    }
    await desktop.saveFile.finish(id);
  } catch (err) {
    desktop.saveFile.cancel(id).catch(() => {});
    throw err;
  }
}

// Resolves to whether the worker took it (else nothing was saved).
async function saveThroughWorker(meta, name) {
  const url = streamUrl(meta, name);
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = url;
  document.body.appendChild(frame);
  const started = Date.now();
  let status = streamStatus(url);
  while (!status.saving && !status.failed && Date.now() - started < WORKER_START_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = streamStatus(url);
  }
  releaseStream(url);
  // The browser keeps downloading once it has the response; the frame only has to last till then.
  setTimeout(() => frame.remove(), status.saving ? 60_000 : 0);
  return status.saving;
}

// Saves the attachment `url` (`meta`, parsed by parseAttachmentUrl) as `name`.
// `onProgress(fraction)` hears how the download goes, when the app is the one downloading it.
export async function saveAttachment(url, meta, name, onProgress) {
  const cached = getCachedAttachment(url);
  if (cached) return triggerDownload(cached, name);
  if (meta.version === 2 && meta.size >= STREAM_SAVE_MIN_BYTES) {
    if (isAndroidApp()) return saveInAndroidApp(meta, name, onProgress);
    if (desktop?.saveFile) return saveInDesktopApp(meta, name, onProgress);
    if (await canDownloadThroughWorker() && await saveThroughWorker(meta, name)) return undefined;
  }
  return triggerDownload(await loadDecryptedAttachment(url, meta, onProgress), name);
}
