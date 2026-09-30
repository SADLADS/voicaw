// GIFs for the emoji picker's GIFs tab, from Klipy (klipy.com). Searches go through here, so
// the API key (appSettings `klipyApiKey`) stays on the server and Klipy never sees who is
// searching (just a per-user pseudonym, see customerId). The GIFs themselves load straight
// from Klipy's CDN. Favourites are kept per user, so they follow you between devices.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { jwtSecret } = require('../config');
const { getSetting } = require('../appSettings');

const router = express.Router();

const KLIPY_API = 'https://api.klipy.com/api/v1';
// Where Klipy's GIFs live; favourites may only point there.
const MEDIA_ORIGIN = 'https://static.klipy.com/';
const PER_PAGE = 30;
const MAX_FAVORITES = 500;
const MAX_QUERY = 100;

// Klipy wants a stable id per user. An HMAC of our id, so it can't be linked back to anyone.
function customerId(userId) {
  return crypto.createHmac('sha256', jwtSecret).update(`klipy-customer:${userId}`).digest('hex').slice(0, 32);
}

function isMediaUrl(url) {
  return typeof url === 'string' && url.length <= 500 && url.startsWith(MEDIA_ORIGIN);
}

// Klipy's item → what the client uses: `url` (sent in messages; animated WebP, much smaller
// than the GIF) at `width`×`height`, and a small `preview` for the picker grid.
function toGif(item) {
  if (item?.type && item.type !== 'gif') return null; // e.g. ads
  const file = item?.file;
  const full = file?.hd?.webp ?? file?.hd?.gif ?? file?.md?.webp ?? file?.md?.gif;
  const small = file?.sm?.webp ?? file?.sm?.gif ?? full;
  if (!full || !isMediaUrl(full.url) || !isMediaUrl(small?.url)) return null;
  return {
    id: String(item.id),
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
    url: full.url,
    width: full.width,
    height: full.height,
    preview: small.url,
    previewWidth: small.width,
    previewHeight: small.height,
  };
}

// A favourite as the client sent it back: only what toGif makes, and only Klipy URLs.
function cleanGif(gif) {
  if (!gif || typeof gif !== 'object') return null;
  const dim = (n) => (Number.isInteger(n) && n > 0 && n <= 10000 ? n : null);
  const out = {
    id: typeof gif.id === 'string' && /^[\w-]{1,64}$/.test(gif.id) ? gif.id : null,
    title: typeof gif.title === 'string' ? gif.title.slice(0, 200) : '',
    url: isMediaUrl(gif.url) ? gif.url : null,
    width: dim(gif.width),
    height: dim(gif.height),
    preview: isMediaUrl(gif.preview) ? gif.preview : null,
    previewWidth: dim(gif.previewWidth),
    previewHeight: dim(gif.previewHeight),
  };
  return out.id && out.url && out.preview && out.width && out.height ? out : null;
}

async function klipy(req, res, path, params) {
  const key = await getSetting('klipyApiKey');
  if (!key) return res.status(503).json({ error: 'GIFs are not set up on this server' });
  const page = Math.max(1, Math.min(50, parseInt(req.query.page, 10) || 1));
  const url = new URL(`${KLIPY_API}/${encodeURIComponent(key)}/gifs/${path}`);
  for (const [name, value] of Object.entries({ ...params, page, per_page: PER_PAGE, customer_id: customerId(req.user.id) })) {
    url.searchParams.set(name, value);
  }
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Klipy answered ${response.status}`);
    body = await response.json();
  } catch (err) {
    // Not the URL: it contains the key.
    console.error(`GIF ${path} failed: ${err.message}`);
    return res.status(502).json({ error: "Couldn't reach the GIF service" });
  }
  const data = body?.data ?? {};
  res.json({
    gifs: (Array.isArray(data.data) ? data.data : []).map(toGif).filter(Boolean),
    next: data.has_next ? page + 1 : null,
  });
}

router.get('/gifs/trending', authenticateJWT, (req, res) => klipy(req, res, 'trending', {}));

router.get('/gifs/search', authenticateJWT, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY) : '';
  if (!q) return res.status(400).json({ error: 'Missing q' });
  return klipy(req, res, 'search', { q });
});

// Newest first.
router.get('/gif-favorites', authenticateJWT, async (req, res) => {
  const rows = await db.all(
    'SELECT gif FROM gif_favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC',
    [req.user.id]
  );
  res.json({ favorites: rows.map((r) => JSON.parse(r.gif)) });
});

router.put('/gif-favorites/:id', authenticateJWT, async (req, res) => {
  const gif = cleanGif(req.body?.gif);
  if (!gif || gif.id !== req.params.id) return res.status(400).json({ error: 'Invalid GIF' });
  const { count } = await db.get('SELECT COUNT(*) AS count FROM gif_favorites WHERE user_id = ?', [req.user.id]);
  const exists = await db.get('SELECT 1 FROM gif_favorites WHERE user_id = ? AND gif_id = ?', [req.user.id, gif.id]);
  if (!exists && count >= MAX_FAVORITES) {
    return res.status(400).json({ error: `You can keep up to ${MAX_FAVORITES} favourite GIFs` });
  }
  await db.run(
    `INSERT INTO gif_favorites (user_id, gif_id, gif, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, gif_id) DO NOTHING`,
    [req.user.id, gif.id, JSON.stringify(gif), Date.now()]
  );
  res.status(204).end();
});

router.delete('/gif-favorites/:id', authenticateJWT, async (req, res) => {
  await db.run('DELETE FROM gif_favorites WHERE user_id = ? AND gif_id = ?', [req.user.id, req.params.id]);
  res.status(204).end();
});

module.exports = router;
module.exports.toGif = toGif;
