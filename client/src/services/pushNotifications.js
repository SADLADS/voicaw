import { loadEncryptionKey, loadOwnPublicKeys } from './keyStore';
import { deriveConversationKey, decryptMessage, decryptReaction, dmContext, reactionContext } from './encryptionService';
import {
  decryptGroupMessage, decryptGroupReaction, groupMessageContext, groupReactionContext, messageSignatureContext, openGroupName,
  reactionSignatureContext,
} from './groupCrypto';
import { getPinnedContact } from './contactKeys';
import { recallGroup, rememberGroupName } from './groupCache';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { customEmojiToText } from '../emoji/customEmoji';
import { mentionsToText } from '../utils/mentions';
import { hideSpoilers } from '../utils/remarkDiscord';
import { isPollReaction, parsePoll } from '../utils/pollMarkup';
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

// "Reacted 👍 to your message: <its text>" (`text` null: without it). Custom emoji as :name:.
function reactedText(emoji, text, reactorName = null) {
  const params = { emoji: customEmojiToText(emoji), text, name: reactorName };
  const key = reactorName ? 'app.push.nameReacted' : 'app.push.reacted';
  return t(text ? `${key}To` : key, params);
}

// A reaction to your message in a DM: opened with the reactor's key this device has already
// checked and remembered (never a key from the push), bound to the message, its two people and
// the reactor, so a server that swapped any of them gets nothing. -> { title, body } or null.
async function dmReaction(data, previews) {
  const myKey = await loadEncryptionKey();
  if (!myKey) return null;
  const reactor = await getPinnedContact(data.senderId, data.reactorId);
  if (!reactor) return null;
  const key = await deriveConversationKey(myKey, reactor.encryptionKey);
  const emoji = await decryptReaction(data.reaction, key, reactionContext(data.messageId, data.reactorId, data.senderId, data.recipientId));
  if (isPollReaction(emoji)) return null;
  let text = null;
  if (previews && data.ciphertext) {
    try {
      const plaintext = await decryptMessage(data.ciphertext, key, dmContext(data.senderId, data.recipientId));
      text = previewText(plaintext, { [data.senderId]: data.authorName, [data.recipientId]: data.title });
    } catch (err) {
      console.warn('Could not decrypt notification preview', err);
    }
  }
  return { title: data.title, body: reactedText(emoji, text) };
}

// The same in a group: the group keys saved on this device (groupCache.js), and the reaction
// only if its signature is the reactor's. -> { title, body } or null.
async function groupReaction(data, previews) {
  const own = await loadOwnPublicKeys();
  const saved = own && String(own.userId) === String(data.senderId) && await recallGroup(own.userId, data.groupId);
  const key = saved?.epochs[data.epoch];
  if (!key) return null;
  const { groupId, epoch, messageId, reactorId, senderId } = data;
  const { emoji, signed, verified } = await decryptGroupReaction(
    data.reaction, key, groupReactionContext(groupId, messageId, reactorId),
    saved.identityKeys[reactorId] ?? 'unknown', reactionSignatureContext({ groupId, epoch, messageId, reactorId })
  );
  if (!signed || !verified || isPollReaction(emoji)) return null;
  const names = Object.fromEntries(saved.members.map((m) => [m.id, m.name]));
  let text = null;
  if (previews && data.ciphertext) {
    try {
      const message = await decryptGroupMessage(
        data.ciphertext, key, groupMessageContext(groupId, epoch, senderId), saved.identityKeys[senderId] ?? 'unknown',
        messageSignatureContext({ groupId, epoch, senderId, replyTo: data.replyTo ?? null, editOf: data.edited ? messageId : null })
      );
      if (message.signed && message.verified) text = previewText(message.text, names);
    } catch (err) {
      console.warn('Could not decrypt notification preview', err);
    }
  }
  const { title } = await groupNotification(data);
  return { title: title || data.title, body: reactedText(emoji, text, names[reactorId] ?? data.reactorName) };
}

// Someone reacted to your message (server/reactionPushes.js). A guild's arrives worded, with
// its emoji and the message's text. An encrypted chat's carries the encrypted reaction (and the
// message when it fits) for this device to open; there the server can't tell a poll vote from
// an emoji, so a vote, or a reaction that won't open, gives null: no notification. Those only
// reach apps that can show nothing (desktop and Android), never a browser, which must show
// every push. -> { title, body } or null.
async function reactionNotification(data) {
  const previews = await getSetting('notificationPreviews');
  if (data.chat === 'guild') return { title: data.title, body: reactedText(data.emoji, previews ? data.preview : null) };
  try {
    if (data.chat === 'dm') return await dmReaction(data, previews);
    if (data.chat === 'group') return await groupReaction(data, previews);
  } catch (err) {
    console.warn('Could not open a reaction for a notification', err);
  }
  return null;
}

// The plaintext of the message a "pinned" or "poll ended" push is about (`messageCiphertext`),
// opened like a preview: in a DM with the other person's key this device checked (never a key
// from the push) and the message's own two people, in a group with the saved group keys and
// only if its signature is its sender's. -> { plaintext, names } or null.
async function openSystemMessage(data) {
  if (!data.messageCiphertext) return null;
  if (data.type === 'dm') {
    const myKey = await loadEncryptionKey();
    const other = myKey && await getPinnedContact(data.recipientId, data.senderId);
    if (!other) return null;
    const key = await deriveConversationKey(myKey, other.encryptionKey);
    const plaintext = await decryptMessage(data.messageCiphertext, key, dmContext(data.messageSenderId, data.messageRecipientId));
    return { plaintext, names: { [data.senderId]: data.title, [data.recipientId]: data.recipientName } };
  }
  const own = await loadOwnPublicKeys();
  const saved = own && await recallGroup(own.userId, data.groupId);
  const key = saved?.epochs[data.epoch];
  if (!key) return null;
  const { groupId, epoch, messageId, messageSenderId } = data;
  const { text, signed, verified } = await decryptGroupMessage(
    data.messageCiphertext, key, groupMessageContext(groupId, epoch, messageSenderId), saved.identityKeys[messageSenderId] ?? 'unknown',
    messageSignatureContext({ groupId, epoch, senderId: messageSenderId, replyTo: data.replyTo ?? null, editOf: data.edited ? messageId : null })
  );
  if (!signed || !verified) return null;
  return { plaintext: text, names: Object.fromEntries(saved.members.map((m) => [m.id, m.name])) };
}

// A "pinned a message" or "poll ended" row (server/systemPushes.js, `system` 'pin' / 'poll_end'),
// worded here: "Pinned a message: <its text>", "Ann's poll “<question>” has closed". The text
// is the message's (a guild's arrives as `preview`; DMs and groups open theirs above), left out
// when it won't open or Settings → Privacy hides message text. Always true without it, so
// these are always shown. -> the body.
async function systemBody(data) {
  let text = null;
  if (await getSetting('notificationPreviews')) {
    if (data.type === 'guild') text = data.preview || null;
    else {
      try {
        const opened = await openSystemMessage(data);
        if (opened) text = data.system === 'poll_end' ? parsePoll(opened.plaintext)?.question ?? null : previewText(opened.plaintext, opened.names);
      } catch (err) {
        console.warn('Could not decrypt notification preview', err);
      }
    }
  }
  const name = data.actorName;
  if (data.system === 'poll_end') {
    if (data.mine) return text ? t('app.push.ownPollClosedQuestion', { question: text }) : t('app.push.ownPollClosed');
    return text ? t('app.push.pollClosedQuestion', { name, question: text }) : t('app.push.pollClosed', { name });
  }
  // A group's title is the group, so it says who pinned; a DM's and a guild's title already do.
  if (data.type === 'group') return text ? t('app.push.namePinnedText', { name, text }) : t('app.push.namePinned', { name });
  return text ? t('app.push.pinnedText', { text }) : t('app.push.pinned');
}

// Pushes whose body is a message's text, which Settings → Privacy's "Show message text in
// notifications" (settingsStore `notificationPreviews`) leaves out. DMs and groups decrypt
// theirs (above) only when it's on; guild messages and bot DMs arrive readable from the server,
// so their body is swapped for a generic one here.
const PLAIN_MESSAGE_PUSHES = new Set(['guild', 'bot_dm']);

// Admins: a new report, sign-up request or tester request (server/adminAlerts.js), with how many
// are waiting; worded here so it's in the device's language.
const ADMIN_COUNTS = { report: 'reportsOpen', signup: 'signupsWaiting', tester: 'testersWaiting' };

function adminNotification(data) {
  if (!ADMIN_COUNTS[data.kind]) return { title: data.title, body: data.body };
  return {
    title: t(`app.push.admin.${data.kind}`),
    body: data.kind === 'signup' && data.name
      ? t('app.push.admin.signupFrom', { name: data.name })
      : t(`app.push.admin.${ADMIN_COUNTS[data.kind]}`, { count: data.count }),
  };
}

// A friend request, or one accepted (server/friendPushes.js), titled with the person's name.
function friendNotification(data) {
  const body = { request: 'app.push.friendRequest', accepted: 'app.push.friendAccepted' }[data.kind];
  return { title: data.name || data.title, body: body ? t(body) : data.body };
}

// -> { title, options }, or null for a push to drop unshown (only reactions, see above).
export async function notificationFromPush(data) {
  let title = data.title || 'Voicaw';
  let body = data.type === 'dm' ? (await dmPreview(data)) || t('app.push.newMessage') : data.body || '';
  if (data.type === 'reaction') {
    const reaction = await reactionNotification(data);
    if (!reaction) return null;
    ({ title, body } = reaction);
  }
  if (data.type === 'admin') ({ title, body } = adminNotification(data));
  if (data.type === 'friend') ({ title, body } = friendNotification(data));
  if (data.system === 'pin' || data.system === 'poll_end') body = await systemBody(data);
  else if (PLAIN_MESSAGE_PUSHES.has(data.type) && !(await getSetting('notificationPreviews'))) body = t('app.push.newMessage');
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
