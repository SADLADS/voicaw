const crypto = require('crypto');
const express = require('express');
const { s3Endpoint } = require('../config');
const { authenticateJWT } = require('../auth');
const {
  getUploadUrl, startMultipartUpload, getUploadPartUrl, listUploadedParts, completeMultipartUpload, abortMultipartUpload,
} = require('../s3');
const { BUCKET, registerUpload } = require('../uploads');
const { uploadLimitBytes } = require('../appSettings');
const { getMember } = require('../guilds');
const { PERMISSIONS, has } = require('../permissions');

// Uploads go straight from the browser to the object store; the server only hands out
// short-lived pre-signed PUT URLs. Attachments arrive already encrypted by the client.
const router = express.Router();

// Upload sizes are signed into the pre-signed URL (the object store rejects a body of any
// other length), so these limits can't be bypassed by uploading straight to the bucket.
// One request is at most 100MB, media.voicaw.com's nginx client_max_body_size; bigger files
// (up to Settings → Admin's File size limit) come in parts.
const MAX_SINGLE_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ICON_BYTES = 8 * 1024 * 1024;
// A multipart upload's parts (each but the last): 32 of an attachment's encrypted 256 KiB
// chunks (client/src/services/chunkedAttachment.js), so the client can encrypt and send one
// part at a time. The store needs at least 5 MiB.
const PART_BYTES = 32 * (256 * 1024 + 16);
// An unfinished upload is forgotten after a day (the store drops its parts then too), and
// one person may have a few going at once.
const MULTIPART_SECONDS = 24 * 60 * 60;
const MAX_MULTIPART_PER_USER = 10;

// Checks the `size` query param; returns { status, error } if it's no good, else null.
function checkUploadSize(size, max) {
  if (!Number.isInteger(size) || size <= 0) return { status: 400, error: 'Missing or invalid size' };
  if (size > max) return { status: 413, error: `File too large (max ${max} bytes)` };
  return null;
}

// A guild's icon (Manage Guild), stored as guild-icons/<guild id>. Once it's uploaded the
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
  const sizeError = checkUploadSize(size, MAX_ICON_BYTES);
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
  const sizeError = checkUploadSize(size, Math.min(MAX_SINGLE_UPLOAD_BYTES, await uploadLimitBytes()));
  if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

  const filename = newFilename(type);
  try {
    const uploadUrl = await getUploadUrl(filename, BUCKET, type, size);
    // Registered first: it's deleted unless a message links to it within a day (uploads.js).
    await registerUpload(filename, req.user.id);
    res.status(201).json({ uploadUrl, fileUrl: fileUrlOf(filename) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Attachments are encrypted client-side and uploaded as opaque binary blobs.
function newFilename(type) {
  const ext = type === 'application/octet-stream' ? 'bin' : (type.split('/')[1] || 'bin');
  return `${crypto.randomUUID()}.${ext}`;
}

const fileUrlOf = (filename) => `${s3Endpoint}/${BUCKET}/${filename}`;

// Unfinished multipart uploads, by file name: { userId, uploadId, size, partCount, started }.
// Kept in memory: a restart fails the uploads going on, which the client reports like any
// other failed upload.
const multipart = new Map();

function forgetOldUploads() {
  const cutoff = Date.now() - MULTIPART_SECONDS * 1000;
  for (const [name, upload] of multipart) {
    if (upload.started < cutoff) multipart.delete(name);
  }
}

// Part `number`'s length (from 1).
const partLength = (upload, number) => (number < upload.partCount ? PART_BYTES : upload.size - PART_BYTES * (upload.partCount - 1));

// The caller's unfinished upload `:name`, or a 404 sent.
function ownUpload(req, res) {
  const upload = multipart.get(req.params.name);
  if (!upload || upload.userId !== req.user.id) {
    res.status(404).json({ error: 'Upload not found' });
    return null;
  }
  return upload;
}

// A file too big for one request: { name, fileUrl, partSize, partCount }. The client then
// asks for each part's URL, puts the part there, and finishes (or abandons) the upload.
router.post('/upload_file/multipart', authenticateJWT, async (req, res) => {
  const type = req.body?.type;
  const size = Number(req.body?.size);
  if (typeof type !== 'string' || !type) return res.status(400).json({ error: 'Missing content type' });
  const sizeError = checkUploadSize(size, await uploadLimitBytes());
  if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });
  forgetOldUploads();
  const going = [...multipart.values()].filter((u) => u.userId === req.user.id).length;
  if (going >= MAX_MULTIPART_PER_USER) return res.status(429).json({ error: 'Too many uploads at once' });

  const filename = newFilename(type);
  try {
    const uploadId = await startMultipartUpload(BUCKET, filename, type);
    await registerUpload(filename, req.user.id);
    const partCount = Math.ceil(size / PART_BYTES);
    multipart.set(filename, { userId: req.user.id, uploadId, size, partCount, started: Date.now() });
    res.status(201).json({ name: filename, fileUrl: fileUrlOf(filename), partSize: PART_BYTES, partCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start the upload' });
  }
});

router.post('/upload_file/multipart/:name/parts/:number', authenticateJWT, async (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1 || number > upload.partCount) {
    return res.status(400).json({ error: 'No such part' });
  }
  try {
    const url = await getUploadPartUrl(BUCKET, req.params.name, upload.uploadId, number, partLength(upload, number));
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Puts the parts together, once the store has every one at its length.
router.post('/upload_file/multipart/:name/complete', authenticateJWT, async (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  try {
    const parts = await listUploadedParts(BUCKET, req.params.name, upload.uploadId);
    const complete = parts.length === upload.partCount
      && parts.every((p, i) => p.PartNumber === i + 1 && p.Size === partLength(upload, i + 1));
    if (!complete) return res.status(409).json({ error: 'Some parts are missing' });
    await completeMultipartUpload(BUCKET, req.params.name, upload.uploadId, parts);
    multipart.delete(req.params.name);
    res.json({ fileUrl: fileUrlOf(req.params.name) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finish the upload' });
  }
});

router.delete('/upload_file/multipart/:name', authenticateJWT, async (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  multipart.delete(req.params.name);
  await abortMultipartUpload(BUCKET, req.params.name, upload.uploadId);
  res.status(204).end();
});

module.exports = router;
module.exports.PART_BYTES = PART_BYTES;
