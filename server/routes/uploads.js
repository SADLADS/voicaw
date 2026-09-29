const crypto = require('crypto');
const express = require('express');
const { s3Endpoint } = require('../config');
const { authenticateJWT } = require('../auth');
const { getUploadUrl } = require('../s3');
const { getMember } = require('../guilds');
const { PERMISSIONS, has } = require('../permissions');

// Uploads go straight from the browser to the object store; the server only hands out
// short-lived pre-signed PUT URLs. Attachments arrive already encrypted by the client.
const router = express.Router();

// Upload sizes are signed into the pre-signed URL (the object store rejects a body of any
// other length), so these limits can't be bypassed by uploading straight to the bucket.
// 100MB matches media.voicaw.com's nginx client_max_body_size.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PROFILE_PIC_BYTES = 8 * 1024 * 1024;

// Checks the `size` query param; returns { status, error } if it's no good, else null.
function checkUploadSize(size, max) {
  if (!Number.isInteger(size) || size <= 0) return { status: 400, error: 'Missing or invalid size' };
  if (size > max) return { status: 413, error: `File too large (max ${max} bytes)` };
  return null;
}

router.get('/upload_profile_pic', authenticateJWT, async (req, res) => {
  const { type } = req.query;
  const size = Number(req.query.size);
  if (!type) return res.status(400).json({ error: 'Missing content type' });
  if (!type.startsWith('image/')) return res.status(400).json({ error: 'Profile pictures must be images' });
  const sizeError = checkUploadSize(size, MAX_PROFILE_PIC_BYTES);
  if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

  try {
    const url = await getUploadUrl(`${req.user.id}`, 'profile-pics', type, size);
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate URL' });
  }
});

// A guild's icon (Manage Server), stored as guild-icons/<guild id>. Once it's uploaded the
// client sends PATCH /guilds/:id { iconUploaded: true }, which bumps the icon's version.
router.get('/upload_guild_icon', authenticateJWT, async (req, res) => {
  const { type } = req.query;
  const size = Number(req.query.size);
  const member = await getMember(Number(req.query.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  if (!has(member.permissions, PERMISSIONS.MANAGE_GUILD)) return res.status(403).json({ error: "You don't have permission to do that" });
  const { guild } = member;
  if (!type) return res.status(400).json({ error: 'Missing content type' });
  if (!type.startsWith('image/')) return res.status(400).json({ error: 'Guild icons must be images' });
  const sizeError = checkUploadSize(size, MAX_PROFILE_PIC_BYTES);
  if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

  try {
    const url = await getUploadUrl(`${guild.id}`, 'guild-icons', type, size);
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate URL' });
  }
});

router.get('/upload_file', authenticateJWT, async (req, res) => {
  const { type } = req.query;
  const size = Number(req.query.size);
  if (!type) return res.status(400).json({ error: 'Missing content type' });
  const sizeError = checkUploadSize(size, MAX_UPLOAD_BYTES);
  if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

  // Attachments are encrypted client-side and uploaded as opaque binary blobs.
  const ext = type === 'application/octet-stream' ? 'bin' : (type.split('/')[1] || 'bin');
  const filename = `${crypto.randomUUID()}.${ext}`;
  const bucket = 'uploads';
  try {
    const uploadUrl = await getUploadUrl(filename, bucket, type, size);
    res.status(201).json({ uploadUrl, fileUrl: `${s3Endpoint}/${bucket}/${filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

module.exports = router;
