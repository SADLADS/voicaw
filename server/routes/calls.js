const express = require('express');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const calls = require('../calls');
const groups = require('../groupDms');

// DM and group DM voice calls (see calls.js): ring someone or a group, answer or join,
// decline, hang up, and the call you're in or being rung for (for a page that just loaded).
const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The encrypted call key ("v1." + base64 of IV, 44 bytes of base64 key, tag).
const MAX_KEY_ENVELOPE = 200;

function requireVoice(req, res, next) {
  if (!config.livekit) return res.status(503).json({ error: "Calls aren't set up on this server" });
  next();
}

// The call the caller is in or being rung for, or null.
router.get('/dm-calls/current', authenticateJWT, (req, res) => {
  const call = calls.currentCallFor(req.user.id);
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

// A group call: { callId, epoch, keyEnvelope } (the call key, encrypted with the group's key
// of `epoch`). Rings the other members. 409 with the `call` if the group has one already
// (join that instead). Returns { call, url, token }.
router.post('/group-dms/:groupId/call', authenticateJWT, requireVoice, async (req, res) => {
  const state = await groups.memberState(req.params.groupId, req.user.id);
  if (!state) return res.status(404).json({ error: 'Group not found' });
  const { callId, epoch, keyEnvelope } = req.body ?? {};
  if (typeof callId !== 'string' || !UUID.test(callId)) return res.status(400).json({ error: 'Invalid call id' });
  if (typeof keyEnvelope !== 'string' || !keyEnvelope.startsWith('v1.') || keyEnvelope.length > MAX_KEY_ENVELOPE) {
    return res.status(400).json({ error: 'Invalid call key' });
  }
  if (!state.latestEpoch || epoch !== state.latestEpoch.epoch) return res.status(409).json({ error: 'The group changed; try again', code: 'stale_epoch' });
  const existing = calls.groupCall(state.group.id);
  if (existing) return res.status(409).json({ error: 'There is already a call in this group', call: calls.publicCall(existing) });
  const call = await calls.startGroupCall({
    id: callId,
    group: state.group,
    caller: { id: req.user.id, username: req.user.username },
    keyEnvelope,
    keyEpoch: epoch,
    members: [...state.members],
  });
  res.status(201).json({ call: calls.publicCall(call), ...(await calls.tokenFor(call, req.user.id, req.user.username)) });
});

// The call, if the caller is in it (1:1), or in its group (group calls).
async function findCall(req, res, next) {
  const call = calls.calls.get(req.params.callId);
  const allowed = call && (call.groupId
    ? await groups.memberState(call.groupId, req.user.id)
    : call.callerId === req.user.id || call.calleeId === req.user.id);
  if (!allowed) return res.status(404).json({ error: 'Call not found' });
  req.call = call;
  next();
}

// Answer (1:1: the person called, while it rings) or join (a group call, any member, any
// time). Returns { call, url, token }.
router.post('/dm-calls/:callId/accept', authenticateJWT, requireVoice, findCall, async (req, res) => {
  const { call } = req;
  if (!call.groupId) {
    if (call.calleeId !== req.user.id) return res.status(403).json({ error: "You can't answer your own call" });
    if (call.state !== 'ringing') return res.status(409).json({ error: 'Already answered' });
  }
  await calls.acceptCall(call, req.user.id);
  res.json({ call: calls.publicCall(call), ...(await calls.tokenFor(call, req.user.id, req.user.username)) });
});

router.post('/dm-calls/:callId/decline', authenticateJWT, findCall, async (req, res) => {
  const { call } = req;
  if (!call.ringing.has(req.user.id)) return res.status(409).json({ error: "Can't decline this call" });
  await calls.declineCall(call, req.user.id);
  res.json({ success: true });
});

// Hang up (1:1: either person, ending it; the caller before an answer cancels it) or leave
// a group call.
router.delete('/dm-calls/:callId', authenticateJWT, findCall, async (req, res) => {
  await calls.endCallOf(req.user.id);
  res.json({ success: true });
});

module.exports = router;
