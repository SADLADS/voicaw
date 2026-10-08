const crypto = require('crypto');
const db = require('./db');
const { s3Endpoint } = require('./config');
const { getObject, putObject, deleteObject, listTopLevelKeys } = require('./s3');
const { processAvatar } = require('./avatarImage');

// Profile pictures. Each one is processed on the server (avatarImage.js) and stored under a
// new name, profile-pics/<user id>/<avatar id>.webp, so its URL never changes and can be cached
// for good; users.avatar holds the current avatar id (null: the default picture). Changing it
// sends `user_profile` (with `avatar`), so everyone's app shows the new one at once.
// Originals are uploaded (pre-signed) to profile-pics/src/<user id>/<upload id> and deleted
// once processed.

const BUCKET = 'profile-pics';
const key = (userId, avatar) => `${userId}/${avatar}.webp`;
const sourceKey = (userId, uploadId) => `src/${userId}/${uploadId}`;

// The picture's public URL, or null for the default one.
function avatarUrl(userId, avatar) {
  return avatar ? `${s3Endpoint}/${BUCKET}/${key(userId, avatar)}` : null;
}

// Processes `original` (cut to `crop`, see avatarImage.js parseCrop), stores it as the user's
// new picture and removes the previous one. Resolves to the new avatar id. Throws
// AvatarImageError for images that can't be used.
async function setAvatarFrom(userId, original, crop = null) {
  const image = await processAvatar(original, crop);
  const avatar = crypto.randomUUID();
  await putObject(BUCKET, key(userId, avatar), image.buffer, image.contentType);
  const before = await db.get('SELECT avatar FROM users WHERE id = ?', [userId]);
  await db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, userId]);
  if (before?.avatar) await deleteObject(BUCKET, key(userId, before.avatar));
  return avatar;
}

async function removeAvatar(userId) {
  const before = await db.get('SELECT avatar FROM users WHERE id = ?', [userId]);
  await db.run('UPDATE users SET avatar = NULL WHERE id = ?', [userId]);
  if (before?.avatar) await deleteObject(BUCKET, key(userId, before.avatar));
}

// Pictures from before this (one object per user, profile-pics/<user id>, unprocessed) become
// processed ones. Run when the server starts: once they're all converted, there are no such
// objects left and it's one listing request. Anything unreadable is dropped.
async function migrateLegacyAvatars() {
  let keys;
  try {
    keys = await listTopLevelKeys(BUCKET);
  } catch (err) {
    console.error('Could not list old profile pictures:', err.code || err.name);
    return;
  }
  for (const legacy of keys.filter((k) => /^\d+$/.test(k))) {
    const userId = Number(legacy);
    try {
      const user = await db.get('SELECT avatar FROM users WHERE id = ?', [userId]);
      if (user && !user.avatar) await setAvatarFrom(userId, await getObject(BUCKET, legacy));
    } catch (err) {
      console.error('Could not convert an old profile picture:', userId, err.message);
    }
    await deleteObject(BUCKET, legacy);
  }
}

module.exports = { BUCKET, avatarUrl, sourceKey, setAvatarFrom, removeAvatar, migrateLegacyAvatars };
