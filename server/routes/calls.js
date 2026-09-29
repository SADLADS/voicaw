const express = require('express');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const calls = require('../calls');

// DM voice calls (see calls.js): ring someone, answer, decline, hang up, and the call you're
// in (for a page that just loaded).
const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The encrypted call key ("v1." + base64 of IV, 44 bytes of base64 key, tag).
const MAX_KEY_ENVELOPE = 200;

function requireVoice(req, res, next) {
  if (!config.livekit) return res.status(503).json({ error: "Calls aren't set up on this server" });
  next();
}

// The call the caller is in (ringing or answered), or null.
router.get('/dm-calls/current', authenticateJWT, (req, res) => {
  const call = calls.callOf(req.user.id);
  res.json(call ? calls.publicCall(call) : null);
});

// Ring someone: { calleeId, callId (a UUID the caller made), keyEnvelope (the call key,
// encrypted for the DM) }. Returns { call, url, token }: the caller joins the room right away.
router.post('/dm-calls', authenticateJWT, requireVoice, async (req, res) => {
  const { calleeId, callId, keyEnvelope } = req.body ?? {};
  const callee = await calls.userById(calleeId);
  if (!callee || callee.id === req.user.id) return res.status(404).json({ error: 'User not found' });
  if (typeof callId !== 'string' || !UUID.test(callId)) return res.status(400).json({ error: 'Invalid call id' });
  if (typeof keyEnvelope !== 'string' || !keyEnvelope.startsWith('v1.') || keyEnvelope.length > MAX_KEY_ENVELOPE) {
    return res.status(400).json({ error: 'Invalid call key' });
  }
  let call;
  try {
    call = await calls.startCall({ id: callId, caller: { id: req.user.id, username: req.user.username }, callee, keyEnvelope });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  res.status(201).json({ call: calls.publicCall(call), ...(await calls.tokenFor(call, req.user.id, req.user.username)) });
});

// The call, if the caller is in it.
function findCall(req, res, next) {
  const call = calls.calls.get(req.params.callId);
  if (!call || (call.callerId !== req.user.id && call.calleeId !== req.user.id)) {
    return res.status(404).json({ error: 'Call not found' });
  }
  req.call = call;
  next();
}

// Answer (the person called, while it rings). Returns { call, url, token }.
router.post('/dm-calls/:callId/accept', authenticateJWT, requireVoice, findCall, async (req, res) => {
  const { call } = req;
  if (call.calleeId !== req.user.id) return res.status(403).json({ error: "You can't answer your own call" });
  if (call.state !== 'ringing') return res.status(409).json({ error: 'Already answered' });
  await calls.acceptCall(call);
  res.json({ call: calls.publicCall(call), ...(await calls.tokenFor(call, req.user.id, req.user.username)) });
});

router.post('/dm-calls/:callId/decline', authenticateJWT, findCall, async (req, res) => {
  const { call } = req;
  if (call.calleeId !== req.user.id || call.state !== 'ringing') return res.status(409).json({ error: "Can't decline this call" });
  await calls.endCall(call, 'declined');
  res.json({ success: true });
});

// Hang up (either person; the caller before it's answered cancels it).
router.delete('/dm-calls/:callId', authenticateJWT, findCall, async (req, res) => {
  await calls.endCallOf(req.user.id);
  res.json({ success: true });
});

module.exports = router;
