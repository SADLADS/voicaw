const WebSocket = require('ws');
const { verifyToken } = require('./auth');

// Realtime push to the browser: each logged-in user's open sockets (one per tab/device),
// keyed by user id as a string. Routes use sendToUserSockets; the socket server itself only
// exists when index.js runs as the server (not in tests).
const clients = new Map();

// Presence has to be fresh: a phone that locks may not get to report going hidden.
const PRESENCE_FRESH_MS = 35000;
const HEARTBEAT_MS = 30000;

function sendToUserSockets(userId, payload) {
  const message = JSON.stringify(payload);
  for (const socket of clients.get(String(userId)) || []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function isOnline(userId) {
  return clients.has(String(userId));
}

// A recipient is "viewing" a conversation if one of their sockets recently reported
// (see the `presence` websocket message) that it's visible and showing that chat.
function isViewingConversation(userId, otherUserId) {
  const now = Date.now();
  return (clients.get(String(userId)) || []).some((s) =>
    s.readyState === WebSocket.OPEN &&
    s.presence?.visible &&
    s.presence.chatId === String(otherUserId) &&
    now - s.presence.at < PRESENCE_FRESH_MS
  );
}

// Runs the websocket server on `server` (the HTTP server). Clients identify with their JWT
// ({ type: 'identify', token }) and report presence; a heartbeat drops dead connections.
function attachWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  function broadcastUserStatus(userId, status) {
    const message = JSON.stringify({ type: 'user_status', userId, status });
    // Only to identified (logged-in) sockets: anyone can open a websocket.
    wss.clients.forEach((client) => {
      if (client.userId && client.readyState === WebSocket.OPEN) client.send(message);
    });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch (err) {
        console.error('Invalid websocket message', err);
        return;
      }
      if (data.type === 'identify') {
        const user = await verifyToken(data.token);
        if (!user) {
          ws.close(1008, 'Invalid token');
          return;
        }
        ws.userId = String(user.id);
        if (!clients.has(ws.userId)) clients.set(ws.userId, []);
        clients.get(ws.userId).push(ws);
        broadcastUserStatus(ws.userId, 'online');
      } else if (data.type === 'presence' && ws.userId) {
        // Whether this client is on screen and which conversation it shows; used to skip
        // push notifications for a chat the user is already looking at.
        ws.presence = {
          visible: data.visible === true,
          chatId: data.chatId != null ? String(data.chatId) : null,
          at: Date.now(),
        };
      }
    });

    ws.on('close', () => {
      const { userId } = ws;
      if (!userId || !clients.has(userId)) return;
      const remaining = clients.get(userId).filter((s) => s !== ws);
      if (remaining.length) {
        clients.set(userId, remaining);
      } else {
        clients.delete(userId);
        broadcastUserStatus(userId, 'offline');
      }
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for user ${ws.userId || 'unknown'}:`, err);
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

module.exports = { clients, sendToUserSockets, isOnline, isViewingConversation, attachWebSocketServer };
