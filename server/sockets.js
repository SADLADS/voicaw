const WebSocket = require('ws');
const auth = require('./auth');
const db = require('./db');

// Realtime push to the browser: each logged-in user's open sockets (one per tab/device),
// keyed by user id as a string. Routes use sendToUserSockets; the socket server itself only
// exists when index.js runs as the server (not in tests).
const clients = new Map();

// Presence has to be fresh: a phone that locks may not get to report going hidden.
const PRESENCE_FRESH_MS = 35000;
const HEARTBEAT_MS = 30000;

// Online status, worked out here from each user's sockets (see statusOf):
// 'online' (active on a computer), 'mobile' (active only on a phone), 'idle' (connected, but
// no input for a while), 'offline' (no sockets). Only changes are broadcast. Going offline
// waits OFFLINE_GRACE_MS, so a reload, a network blip or an API restart doesn't flicker.
const STATUS_SWEEP_MS = 15000;
const OFFLINE_GRACE_MS = 15000;
// Clients report how long until they count as idle; never trust more than this.
const MAX_IDLE_IN_MS = 10 * 60 * 1000;
// last_online is also saved while someone is online, so a crash loses at most this much.
const LAST_ONLINE_SAVE_MS = 60000;
const statuses = new Map(); // user id (string) -> status, for everyone not offline
const offlineTimers = new Map();
let lastOnlineSavedAt = 0;

function sendToUserSockets(userId, payload) {
  const message = JSON.stringify(payload);
  for (const socket of clients.get(String(userId)) || []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

// The desktop app (Electron) can't get web push, so whatever would be pushed to a user also
// goes to their desktop app sockets as `notification { payload }` (see push.js), and the app
// shows it. A socket says it's the desktop app with notifications on in its presence message.
function sendToDesktopSockets(userId, payload) {
  const message = JSON.stringify({ type: 'notification', payload });
  let sent = 0;
  for (const socket of clients.get(String(userId)) || []) {
    if (socket.readyState === WebSocket.OPEN && socket.presence?.desktopNotifications) {
      socket.send(message);
      sent++;
    }
  }
  return sent;
}

// To every logged-in socket (anyone can open a websocket; only identified ones are in `clients`).
function sendToAllSockets(payload) {
  for (const userId of clients.keys()) sendToUserSockets(userId, payload);
}

function getStatus(userId) {
  return statuses.get(String(userId)) ?? 'offline';
}

function statusOf(sockets, now = Date.now()) {
  const open = sockets.filter((s) => s.readyState === WebSocket.OPEN);
  if (!open.length) return 'offline';
  const active = open.filter((s) => s.presence?.activeUntil > now);
  if (active.some((s) => !s.presence.mobile)) return 'online';
  return active.length ? 'mobile' : 'idle';
}

function saveLastOnline(userIds, now = Date.now()) {
  if (!userIds.length) return;
  db.run(
    `UPDATE users SET last_online = ? WHERE id IN (${userIds.map(() => '?').join(',')})`,
    [Math.floor(now / 1000), ...userIds]
  ).catch((err) => console.error('Failed to save last_online', err));
}

function setStatus(userId, status) {
  if (getStatus(userId) === status) return;
  const payload = { type: 'user_status', userId, status };
  if (status === 'offline') {
    statuses.delete(userId);
    const now = Date.now();
    saveLastOnline([userId], now);
    payload.lastOnline = Math.floor(now / 1000);
  } else {
    statuses.set(userId, status);
  }
  sendToAllSockets(payload);
}

// Works out `userId`'s status again after their sockets or presence changed.
function refreshStatus(userId) {
  userId = String(userId);
  const status = statusOf(clients.get(userId) || []);
  if (status !== 'offline') {
    clearTimeout(offlineTimers.get(userId));
    offlineTimers.delete(userId);
    setStatus(userId, status);
  } else if (getStatus(userId) !== 'offline' && !offlineTimers.has(userId)) {
    offlineTimers.set(userId, setTimeout(() => {
      offlineTimers.delete(userId);
      if (statusOf(clients.get(userId) || []) === 'offline') setStatus(userId, 'offline');
    }, OFFLINE_GRACE_MS));
  }
}

// Catches people going idle (their activeUntil passing), and saves last_online now and then.
function sweepStatuses() {
  for (const userId of clients.keys()) refreshStatus(userId);
  const now = Date.now();
  if (now - lastOnlineSavedAt >= LAST_ONLINE_SAVE_MS) {
    lastOnlineSavedAt = now;
    saveLastOnline([...statuses.keys()], now);
  }
}

// A recipient is "viewing" a conversation if one of their sockets recently reported
// (see the `presence` websocket message) that it's visible and showing that chat.
function isViewingConversation(userId, otherUserId) {
  const now = Date.now();
  return (clients.get(String(userId)) || []).some((s) =>
    s.readyState === WebSocket.OPEN &&
    s.presence?.visible &&
    (s.presence.chatId === String(otherUserId) || s.presence.sideChatId === String(otherUserId)) &&
    now - s.presence.at < PRESENCE_FRESH_MS
  );
}

// Runs the websocket server on `server` (the HTTP server). Clients identify with their JWT
// ({ type: 'identify', token }) and report presence; a heartbeat drops dead connections.
function attachWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

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
        if (ws.userId || ws.identifying) return;
        ws.identifying = true;
        const user = await auth.verifyToken(data.token);
        ws.identifying = false;
        // Closed while the token was checked: its close handler has already run.
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!user) {
          ws.close(1008, 'Invalid token');
          return;
        }
        ws.userId = String(user.id);
        ws.sessionId = user.sid;
        if (!clients.has(ws.userId)) clients.set(ws.userId, []);
        clients.get(ws.userId).push(ws);
        refreshStatus(ws.userId);
        // Everyone not offline, so a client that was disconnected for a while catches up.
        ws.send(JSON.stringify({ type: 'presence_snapshot', statuses: Object.fromEntries(statuses) }));
      } else if (data.type === 'presence') {
        // Whether this client is on screen and which conversation it shows (used to skip
        // push notifications for a chat the user is already looking at), whether it's a phone,
        // and how long until it counts as idle. Kept even before identify finishes (the
        // client sends it first), so the first status is already right.
        const now = Date.now();
        const idleIn = Math.min(Math.max(Number(data.idleIn) || 0, 0), MAX_IDLE_IN_MS);
        ws.presence = {
          visible: data.visible === true,
          chatId: data.chatId != null ? String(data.chatId) : null,
          // A second chat shown beside it (a thread next to its channel).
          sideChatId: data.sideChatId != null ? String(data.sideChatId) : null,
          mobile: data.mobile === true,
          desktopNotifications: data.desktopNotifications === true,
          activeUntil: now + idleIn,
          at: now,
        };
        if (ws.userId) refreshStatus(ws.userId);
      }
    });

    ws.on('close', () => {
      const { userId } = ws;
      if (!userId || !clients.has(userId)) return;
      const remaining = clients.get(userId).filter((s) => s !== ws);
      if (remaining.length) clients.set(userId, remaining);
      else clients.delete(userId);
      refreshStatus(userId);
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
  const sweep = setInterval(sweepStatuses, STATUS_SWEEP_MS);
  wss.on('close', () => {
    clearInterval(interval);
    clearInterval(sweep);
  });

  return wss;
}

module.exports = {
  clients, sendToUserSockets, sendToAllSockets, sendToDesktopSockets, getStatus, refreshStatus, isViewingConversation, attachWebSocketServer,
};
