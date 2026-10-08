const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { getUploadUrl, getObject, deleteObject } = require('../s3');
const { sendToAllSockets } = require('../sockets');
const { PROFILE_COLUMNS } = require('../profiles');
const { BUCKET, sourceKey, setAvatarFrom, removeAvatar } = require('../avatars');
const { AvatarImageError, MAX_AVATAR_UPLOAD_BYTES, parseCrop } = require('../avatarImage');

// Your profile picture (see avatars.js): upload the original, then say it's ready; or remove it.
const router = express.Router();

// A pending upload is only valid for its uploader, for this long.
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // upload id -> { userId, expires }

async function announce(userId) {
  const profile = await db.get(`SELECT id, username, ${PROFILE_COLUMNS} FROM users WHERE id = ?`, [userId]);
  sendToAllSockets({ type: 'user_profile', user: profile });
  return profile;
}

// Step 1: { type, size } of the image; returns { uploadId, url } (PUT the file there: its type
// and size are signed into the URL).
router.post('/profile/avatar', authenticateJWT, async (req, res) => {
  const { type } = req.body ?? {};
  const size = Number(req.body?.size);
  if (typeof type !== 'string' || !type.startsWith('image/')) return res.status(400).json({ error: 'Profile pictures must be images' });
  if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'Missing file size' });
  if (size > MAX_AVATAR_UPLOAD_BYTES) return res.status(413).json({ error: 'That image is too large (max 8 MB).' });

  const uploadId = crypto.randomUUID();
  pending.set(uploadId, { userId: req.user.id, expires: Date.now() + UPLOAD_TTL_MS });
  const url = await getUploadUrl(sourceKey(req.user.id, uploadId), BUCKET, type, size);
  res.status(201).json({ uploadId, url });
});

// Step 2: the original is uploaded, with `crop` from the app's cropper (optional: the middle
// square). It's processed into your new picture (the original is deleted either way); returns
// your profile, and everyone gets `user_profile`.
router.post('/profile/avatar/:uploadId/ready', authenticateJWT, async (req, res) => {
  const { uploadId } = req.params;
  const upload = pending.get(uploadId);
  if (!upload || upload.userId !== req.user.id || upload.expires < Date.now()) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  pending.delete(uploadId);
  const source = sourceKey(req.user.id, uploadId);
  let original;
  try {
    original = await getObject(BUCKET, source);
  } catch {
    return res.status(400).json({ error: "The picture wasn't uploaded" });
  }
  try {
    await setAvatarFrom(req.user.id, original, parseCrop(req.body?.crop));
  } catch (err) {
    if (err instanceof AvatarImageError) return res.status(400).json({ error: err.message });
    throw err;
  } finally {
    await deleteObject(BUCKET, source);
  }
  res.json(await announce(req.user.id));
});

// Back to the default picture.
router.delete('/profile/avatar', authenticateJWT, async (req, res) => {
  await removeAvatar(req.user.id);
  res.json(await announce(req.user.id));
});

module.exports = router;
