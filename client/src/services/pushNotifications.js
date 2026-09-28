import { loadPrivateKey } from './keyStore';
import { deriveSharedKey, decryptMessage } from './encryptionService';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { getSetting } from './settingsStore';

// Turns a web push payload (see buildDmPushPayload in server/index.js) into the
// notification the service worker shows.

const MAX_PREVIEW_LENGTH = 200;

// DM pushes carry the end-to-end encrypted message when it fits in a push. It's decrypted
// here, on the device, with the user's private key (IndexedDB) for the notification text;
// the server never sees the plaintext. Returns null to fall back to a generic body.
async function dmPreview(data) {
  if (!data.ciphertext || !data.senderPublicKey) return null;
  if (!(await getSetting('notificationPreviews'))) return null;
  try {
    const privateKey = await loadPrivateKey();
    if (!privateKey) return null; // logged out on this device
    const sharedKey = await deriveSharedKey(privateKey, data.senderPublicKey);
    const text = summarizeAttachments(await decryptMessage(data.ciphertext, sharedKey)).trim();
    if (!text) return null;
    return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : text;
  } catch (err) {
    console.warn('Could not decrypt notification preview', err);
    return null;
  }
}

export async function notificationFromPush(data) {
  const body = data.type === 'dm' ? (await dmPreview(data)) || 'New message' : data.body || '';
  return {
    title: data.title || 'Voicaw',
    options: {
      body,
      icon: data.image || '/logo192.png',
      badge: '/badge.png',
      // One notification per conversation: a newer message replaces the older one...
      tag: data.tag,
      // ...but still alerts.
      renotify: Boolean(data.tag),
      timestamp: data.timestamp ? data.timestamp * 1000 : Date.now(),
      data: { url: data.url || '/' },
    },
  };
}
