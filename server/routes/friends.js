const express = require('express');
const { authenticateJWT } = require('../auth');
const friends = require('../friends');
const { sendToUserSockets } = require('../sockets');

// Friends (friends.js). GET /friends: { friends, incoming, outgoing, admin } (`admin`: the app
// shows the Everyone tab). PUT /friends/:userId asks them (or accepts their request), POST
// /friends { username } the same by username, DELETE /friends/:userId removes a friend, declines
// or cancels a request. Each answers with your new lists plus { id, result }, and both people's
// devices get `friends` with their own.
const router = express.Router();

const { listFor } = friends;

// Sends both people their new lists; resolves to `userId`'s.
async function announce(userId, otherId) {
  const [mine, theirs] = await Promise.all([listFor(userId), listFor(otherId)]);
  sendToUserSockets(userId, { type: 'friends', ...mine });
  sendToUserSockets(otherId, { type: 'friends', ...theirs });
  return mine;
}

function failed(res, err) {
  if (!(err instanceof friends.FriendError)) throw err;
  res.status(err.status).json({ error: err.message, code: err.code });
}

router.get('/friends', authenticateJWT, async (req, res) => {
  res.json(await listFor(req.user.id));
});

router.post('/friends', authenticateJWT, async (req, res) => {
  try {
    const { id, result } = await friends.requestByName(req.user.id, req.body?.username);
    res.json({ ...(await announce(req.user.id, id)), id, result });
  } catch (err) {
    failed(res, err);
  }
});

router.put('/friends/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  try {
    const result = await friends.request(req.user.id, id);
    res.json({ ...(await announce(req.user.id, id)), id, result });
  } catch (err) {
    failed(res, err);
  }
});

router.delete('/friends/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  const removed = await friends.remove(req.user.id, id);
  const lists = removed ? await announce(req.user.id, id) : await listFor(req.user.id);
  res.json({ ...lists, id, result: removed ? 'removed' : 'none' });
});

module.exports = router;
