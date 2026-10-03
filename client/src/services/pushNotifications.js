import { loadEncryptionKey, loadOwnPublicKeys } from './keyStore';
import { deriveConversationKey, decryptMessage, dmContext } from './encryptionService';
import { decryptGroupMessage, groupMessageContext, messageSignatureContext, openGroupName } from './groupCrypto';
import { getPinnedContact } from './contactKeys';
import { recallGroup, rememberGroupName } from './groupCache';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { customEmojiToText } from '../emoji/customEmoji';
import { mentionsToText } from '../utils/mentions';
import { hideSpoilers } from '../utils/remarkDiscord';
import { getSetting } from './settingsStore';
import { t } from '../i18n';

// Turns a web push payload (see server/push.js) into the notification the service worker
// shows.

const MAX_PREVIEW_LENGTH = 200;

// A message's text as a notification shows it (`names`: user id -> name, for mentions), or null.
function previewText(plaintext, names) {
  const text = mentionsToText(customEmojiToText(hideSpoilers(summarizeAttachments(plaintext))), names).trim();
  if (!text) return null;
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : text;
}

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
    return previewText(plaintext, { [data.senderId]: data.title, [data.recipientId]: data.recipientName });
  } catch (err) {
    console.warn('Could not decrypt notification preview', err);
    return null;
  }
}

// The members' names, as a group with no name is titled (like utils/groupDisplay.js), or null.
function membersTitle(members, myId) {
  const others = members.filter((m) => String(m.id) !== String(myId)).map((m) => m.name);
  if (others.length === 0) return null;
  if (others.length <= 3) return others.join(', ');
  return t('groups.title.andMore', { names: others.slice(0, 3).join(', '), count: others.length - 3 });
}

// Group pushes (messages and calls) carry the group's encrypted name, and messages the signed,
// encrypted message when it fits. Both are opened here with the group keys the app saved on
// this device after checking the group (groupCache.js), never a key from the push, and the
// message only shows if its signature is its sender's. -> { title, body } (either null to
// fall back to the push's own).
async function groupNotification(data) {
  const own = await loadOwnPublicKeys();
  const saved = own && await recallGroup(own.userId, data.groupId);
  if (!saved) return { title: null, body: null }; // logged out, or the group was never opened here
  const identityKeyOf = (id) => saved.identityKeys[id];

  let name = saved.name;
  const nameKey = saved.epochs[data.nameEpoch];
  if (data.nameCiphertext && nameKey) {
    try {
      const pushed = await openGroupName(data.nameCiphertext, nameKey, data.groupId, data.nameEpoch, identityKeyOf);
      if (!name || pushed.version > name.version) {
        name = pushed;
        await rememberGroupName(own.userId, data.groupId, pushed);
      }
    } catch (err) {
      console.warn("Could not decrypt the group's name", err);
    }
  }
  const title = name?.name || membersTitle(saved.members, own.userId);

  let body = null;
  const key = saved.epochs[data.epoch];
  if (data.type === 'group' && data.ciphertext && key && await getSetting('notificationPreviews')) {
    try {
      const { text, signed, verified } = await decryptGroupMessage(
        data.ciphertext, key, groupMessageContext(data.groupId, data.epoch, data.senderId),
        identityKeyOf(data.senderId) ?? 'unknown',
        messageSignatureContext({ groupId: data.groupId, epoch: data.epoch, senderId: data.senderId, replyTo: data.replyTo ?? null })
      );
      const names = Object.fromEntries(saved.members.map((m) => [m.id, m.name]));
      const preview = signed && verified ? previewText(text, names) : null;
      if (preview) body = `${data.senderName}: ${preview}`;
    } catch (err) {
      console.warn('Could not decrypt notification preview', err);
    }
  }
  return { title, body };
}

export async function notificationFromPush(data) {
  let title = data.title || 'Voicaw';
  let body = data.type === 'dm' ? (await dmPreview(data)) || t('app.push.newMessage') : data.body || '';
  if ((data.type === 'group' || data.type === 'call') && data.groupId) {
    try {
      const group = await groupNotification(data);
      title = group.title || title;
      body = group.body || body;
    } catch (err) {
      console.warn('Could not read the group for a notification', err);
    }
  }
  return {
    title,
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
