import { loadEncryptionKey } from './keyStore';
import { deriveConversationKey, decryptMessage, dmContext } from './encryptionService';
import { getPinnedContact } from './contactKeys';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { customEmojiToText } from '../emoji/customEmoji';
import { mentionsToText } from '../utils/mentions';
import { getSetting } from './settingsStore';

// Turns a web push payload (see buildDmPushPayload in server/index.js) into the
// notification the service worker shows.

const MAX_PREVIEW_LENGTH = 200;

// DM pushes carry the end-to-end encrypted message when it fits in a push. It's decrypted
// here, on the device, for the notification text; the server never sees the plaintext.
// Only the sender's key this device has already checked and remembered is used (never a
// key from the push). Returns null to fall back to a generic body.
async function dmPreview(data) {
  if (!data.ciphertext || data.senderId == null || data.recipientId == null) return null;
  if (!(await getSetting('notificationPreviews'))) return null;
  try {
    const myKey = await loadEncryptionKey();
    if (!myKey) return null; // logged out on this device
    const sender = await getPinnedContact(data.recipientId, data.senderId);
    if (!sender) return null; // never opened a chat with them here: key not checked yet
    const key = await deriveConversationKey(myKey, sender.encryptionKey);
    const plaintext = await decryptMessage(data.ciphertext, key, dmContext(data.senderId, data.recipientId));
    // A DM can only name its two people: the sender (the title) and the recipient.
    const names = { [data.senderId]: data.title, [data.recipientId]: data.recipientName };
    const text = mentionsToText(customEmojiToText(summarizeAttachments(plaintext)), names).trim();
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
