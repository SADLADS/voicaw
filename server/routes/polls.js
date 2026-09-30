const express = require('express');
const { authenticateJWT } = require('../auth');
const { KINDS, PollError, registerPoll, endPollNow } = require('../pollTimers');

// A poll's author tells the server when it closes (`kind`: dm, group or guild), or ends it
// now; see pollTimers.js. That's all the server learns about a poll in an encrypted chat.
const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    if (!KINDS[req.params.kind]) return res.status(404).json({ error: 'Message not found' });
    try {
      res.json(await fn(req.params.kind, Number(req.params.messageId), req.user.id, req.body ?? {}));
    } catch (err) {
      if (!(err instanceof PollError)) throw err;
      res.status(err.status).json({ error: err.message });
    }
  };
}

// { duration } (seconds): once, after sending the poll.
router.post('/polls/:kind/:messageId/timer', authenticateJWT,
  handle((kind, id, userId, body) => registerPoll(kind, id, userId, body.duration)));

// Ends it now and posts its "poll ended" row: { messageId } of the row.
router.post('/polls/:kind/:messageId/end', authenticateJWT,
  handle(async (kind, id, userId) => ({ messageId: await endPollNow(kind, id, userId) })));

module.exports = router;
