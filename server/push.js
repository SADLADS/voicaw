const webpush = require('web-push');
const db = require('./db');
const { vapid } = require('./config');
const { sendFcm } = require('./fcm');

webpush.setVapidDetails(vapid.email, vapid.publicKey, vapid.privateKey);

// Web push payloads must stay under ~4KB, so the (end-to-end encrypted) message is only
// included when it's small enough; the service worker decrypts it on the device for the
// notification preview and falls back to a generic body otherwise.
const MAX_PUSH_CIPHERTEXT_LENGTH = 2800;

// `recipientName` is only for showing mentions (`<@id>`) in the preview.
function buildDmPushPayload(message, imageUrl, recipientName) {
  const payload = {
    type: 'dm',
    title: message.sender_display_name || message.sender_username,
    // What service workers from before previews existed show (the current one decrypts
    // `ciphertext` instead); keeps notifications readable until every device updates.
    body: 'New message',
    url: `/dm/${message.sender_id}`,
    tag: `dm-${message.sender_id}`,
    image: imageUrl,
    senderId: message.sender_id,
    recipientId: message.recipient_id,
    recipientName,
    timestamp: message.timestamp,
  };
  // The service worker decrypts with the sender's key it has already checked and remembered
  // (never a key from the push), so only the ciphertext is included.
  if (message.content.length <= MAX_PUSH_CIPHERTEXT_LENGTH) {
    payload.ciphertext = message.content;
  }
  return payload;
}

// A group push also carries the group's encrypted name (~1150 characters since group pictures,
// ~800 before), so less room is left for the message.
const MAX_GROUP_PUSH_CIPHERTEXT_LENGTH = 1450;

// The group's name for a push: { nameCiphertext, nameEpoch } for the service worker to
// decrypt with the group keys the app saved on the device (never a key from the push), or
// `title` for a group from before names were encrypted.
async function groupNameForPush(groupId, fallback = 'Group') {
  const group = await db.get('SELECT name, name_ciphertext, name_epoch, name_version FROM group_dms WHERE id = ?', [groupId]);
  if (!group?.name_version) return { title: group?.name || fallback };
  return { title: fallback, groupId, nameCiphertext: group.name_ciphertext, nameEpoch: group.name_epoch };
}

// A new group message for `recipientId`: titled with the group's name and with the (signed,
// encrypted) message when they fit, both decrypted on the device like a DM's preview.
async function buildGroupPushPayload(groupId, message, recipientId, senderName) {
  const payload = {
    type: 'group',
    ...(await groupNameForPush(groupId)),
    // What's shown when the device can't decrypt (and by apps from before).
    body: `New message from ${senderName}`,
    url: `/dm/g/${groupId}`,
    tag: `group-${groupId}`,
    timestamp: message.timestamp,
    groupId,
    senderId: message.sender_id,
    senderName,
    recipientId,
    epoch: message.epoch,
    replyTo: message.parent_message_id ?? null,
  };
  if (message.content.length <= MAX_GROUP_PUSH_CIPHERTEXT_LENGTH) payload.ciphertext = message.content;
  return payload;
}

// Pushes about a new message: each of the user's open pages also gets `message_sound`, and
// plays the Message sound if it's in front (or is the desktop app; see client sounds/).
const MESSAGE_PUSHES = new Set(['dm', 'group', 'guild', 'bot_dm']);

// Sends a web push to every device the user has subscribed (forgetting devices whose
// subscription is gone), and the same payload to their desktop apps over the websocket.
// Resolves to { devices, delivered } (desktop apps count as both).
// `appsOnly`: only to desktop and Android apps that said they can drop it unshown (see
// sendToReactionApps), never a browser.
async function sendPushToUser(userId, payload, options = {}, { appsOnly = false } = {}) {
  const sockets = require('./sockets');
  if (MESSAGE_PUSHES.has(payload.type) && payload.tag) noteShown(userId, payload.tag);
  const desktop = sockets.sendToDesktopSockets(userId, payload, { reactionPushes: appsOnly });
  if (MESSAGE_PUSHES.has(payload.type)) sockets.sendToUserSockets(userId, { type: 'message_sound' });
  let rows;
  try {
    rows = await db.all('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?', [userId]);
  } catch {
    return { devices: desktop, delivered: desktop };
  }
  const body = JSON.stringify(payload);
  const results = await Promise.all(rows.map(async (row) => {
    const subscription = JSON.parse(row.subscription);
    if (appsOnly && !subscription.fcm?.reactionPushes) return false;
    try {
      if (subscription.fcm) {
        // The Android app (fcm.js).
        const sent = await sendFcm(subscription.fcm, payload, options);
        if (sent === 'gone') db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]).catch(() => {});
        return sent === true;
      }
      await webpush.sendNotification(subscription, body, { TTL: 24 * 60 * 60, ...options });
      return true;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]).catch(() => {});
      } else {
        console.error('Push notification failed:', error.statusCode || error.message, error.body || '');
      }
      return false;
    }
  }));
  return { devices: rows.length + desktop, delivered: results.filter(Boolean).length + desktop };
}

// A reaction in an encrypted chat. The server can't tell a poll vote from an emoji there (on
// purpose), and a browser must show a notification for every push, so it would sometimes say
// "reacted" about a vote. So these go only to apps that decrypt first and show nothing for a
// vote or a reaction they can't open: desktop apps whose page said so in its presence
// (`reactionPushes`), Android apps whose subscription did (`fcm.reactionPushes`).
function sendToReactionApps(userId, payload, options) {
  return sendPushToUser(userId, payload, options, { appsOnly: true });
}

// Something only the Android app acts on, and shows nothing for (web push must show a
// notification for every push): `call_stop` stops a call ringing on the phone,
// `notification_clear` takes a chat's notification down. `options`: sendFcm's.
async function sendToAndroidApps(userId, payload, options = { TTL: 60 }) {
  let rows;
  try {
    rows = await db.all('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?', [userId]);
  } catch {
    return;
  }
  await Promise.all(rows.map(async (row) => {
    const { fcm } = JSON.parse(row.subscription);
    if (!fcm) return;
    try {
      if (await sendFcm(fcm, payload, options) === 'gone') {
        db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]).catch(() => {});
      }
    } catch (error) {
      console.error('Push notification failed:', error.statusCode || error.message);
    }
  }));
}

// Notifications each user may still have up, so a clear is only sent when there's something
// to take down (a busy guild channel being read would otherwise send one per message). In
// memory: after a restart, notifications from before stay up.
// Messages' tags, one per chat (`dm-5`, `group-3`, `channel-12`, `bot-dm-7`), and friend
// requests' (`friend-5`, friendPushes.js), by user.
const shownTags = new Map();
// Reactions' tags, one per message (`reaction-dm-40`...), by user, then by the chat they're in
// as presence names it (`5` for a DM with user 5, `group-3`, `channel-12`).
const reactionTags = new Map();

function noteShown(userId, tag) {
  const key = String(userId);
  if (!shownTags.has(key)) shownTags.set(key, new Set());
  shownTags.get(key).add(tag);
}

// A reaction notification tagged `tag` went to `userId` about a message in `chatId`.
function noteReactionShown(userId, chatId, tag) {
  const key = String(userId);
  if (!reactionTags.has(key)) reactionTags.set(key, new Map());
  const chats = reactionTags.get(key);
  if (!chats.has(String(chatId))) chats.set(String(chatId), new Set());
  chats.get(String(chatId)).add(tag);
}

// Takes the notifications tagged `tags` down on `userId`'s Android apps (even closed), desktop
// apps and open pages (which close their browser's own; a closed browser can't be reached: web
// push must show something).
function sendClear(userId, tags) {
  require('./sockets').sendToUserSockets(userId, { type: 'notification_clear', tags });
  // Normal priority: nothing to show, so no need to wake a dozing phone (it's done when it
  // next wakes, within the day).
  sendToAndroidApps(userId, { type: 'notification_clear', tags }, { TTL: 24 * 60 * 60, priority: 'normal' }).catch(() => {});
}

// `userId` has read everything in the chat whose notifications are tagged `tag`: its
// notification goes from their devices.
function clearNotifications(userId, tag) {
  const tags = shownTags.get(String(userId));
  if (!tags?.delete(tag)) return;
  if (!tags.size) shownTags.delete(String(userId));
  sendClear(userId, [tag]);
}

// One of `userId`'s devices shows chat `chatId` (its presence, sockets.js): the reaction
// notifications about messages there go from all their devices (the reactions are on screen).
function clearChatReactions(userId, chatId) {
  const chats = reactionTags.get(String(userId));
  const tags = chats?.get(String(chatId));
  if (!tags) return;
  chats.delete(String(chatId));
  if (!chats.size) reactionTags.delete(String(userId));
  sendClear(userId, [...tags]);
}

// The sender's profile picture for the notification (the default one if they have none).
async function getUserImageUrl(userId) {
  const user = await db.get('SELECT avatar FROM users WHERE id = ?', [userId]);
  return require('./avatars').avatarUrl(userId, user?.avatar) ?? '/default.png';
}

module.exports = { MAX_PUSH_CIPHERTEXT_LENGTH, buildDmPushPayload, buildGroupPushPayload, groupNameForPush, sendPushToUser, sendToReactionApps, sendToAndroidApps, noteShown, noteReactionShown, clearNotifications, clearChatReactions, getUserImageUrl };
