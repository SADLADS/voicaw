const WebSocket = require('ws');
const auth = require('./auth');
const db = require('./db');
const activities = require('./activities');

// Realtime push to the browser: each logged-in user's open sockets (one per tab/device),
// keyed by user id as a string. Routes use sendToUserSockets; the socket server itself only
// exists when index.js runs as the server (not in tests).
const clients = new Map();
// Accounts waiting for an admin's approval (signups.js) aren't logged in as far as everyone else
// is concerned: their sockets wait here, get no presence or broadcasts, and join `clients` once
// approved.
const pendingClients = new Map();

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
// Activities (activities.js) a socket may set per minute; games update often, the app sends at
// most one every few seconds.
const ACTIVITY_SETS_PER_MINUTE = 30;
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
// `reactionPushes`: only to those whose page also said it drops reactions it shouldn't show
// (push.js sendToReactionApps).
function sendToDesktopSockets(userId, payload, { reactionPushes = false } = {}) {
  const message = JSON.stringify({ type: 'notification', payload });
  let sent = 0;
  for (const socket of clients.get(String(userId)) || []) {
    if (socket.readyState === WebSocket.OPEN && socket.presence?.desktopNotifications &&
        (!reactionPushes || socket.presence.reactionPushes)) {
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

// Makes `ws` one of `userId`'s logged-in sockets (identified, or just approved).
function addClient(ws, userId) {
  ws.userId = String(userId);
  if (!clients.has(ws.userId)) clients.set(ws.userId, []);
  clients.get(ws.userId).push(ws);
  refreshStatus(ws.userId);
  // Everyone not offline (and what they're playing), so a client that was disconnected for a
  // while catches up.
  ws.send(JSON.stringify({ type: 'presence_snapshot', statuses: Object.fromEntries(statuses), activities: activities.snapshot() }));
}

function removeFrom(map, key, ws) {
  const remaining = (map.get(key) ?? []).filter((s) => s !== ws);
  if (remaining.length) map.set(key, remaining);
  else map.delete(key);
}

// A pending account's sockets: approved (they carry on as logged in, after `account_approved`)
// or declined (`account_deleted`, then closed like a deleted account's).
function approvePendingSockets(userId) {
  const sockets = pendingClients.get(String(userId)) ?? [];
  pendingClients.delete(String(userId));
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    delete ws.pendingUserId;
    ws.send(JSON.stringify({ type: 'account_approved' }));
    addClient(ws, userId);
  }
}

function closePendingSockets(userId) {
  const sockets = pendingClients.get(String(userId)) ?? [];
  pendingClients.delete(String(userId));
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    ws.send(JSON.stringify({ type: 'account_deleted' }));
    ws.close(1008, 'Account deleted');
  }
}

function getStatus(userId) {
  return statuses.get(String(userId)) ?? 'offline';
}

function statusOf(sockets, now = Date.now()) {
  // A bot's gateway session set to Invisible (gateway.js) doesn't count.
  const open = sockets.filter((s) => s.readyState === WebSocket.OPEN && !s.presence?.invisible);
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

// Works out `userId`'s activities again after one of their sockets set some or closed, and
// tells everyone if they changed.
function refreshActivities(userId) {
  userId = String(userId);
  const list = activities.activitiesOf(clients.get(userId));
  if (activities.remember(userId, list)) sendToAllSockets({ type: 'user_activities', userId, activities: list });
  require('./activityHistory').record(userId, list);
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
// Connections to /api/gateway are bots' (gateway.js, Discord's protocol).
function attachWebSocketServer(server) {
  const wss = new WebSocket.Server({ noServer: true });
  const gateway = require('./gateway').createGatewayServer();
  server.on('upgrade', (req, socket, head) => {
    const target = /^\/api\/gateway\/?(\?|$)/.test(req.url ?? '') ? gateway : wss;
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

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
      // A client checking its connection still works (a phone back from sleep: browsers can't
      // see the heartbeat's pings).
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (data.type === 'identify') {
        if (ws.userId || ws.pendingUserId || ws.identifying) return;
        ws.identifying = true;
        const user = await auth.verifyToken(data.token);
        ws.identifying = false;
        // Closed while the token was checked: its close handler has already run.
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!user) {
          ws.close(1008, 'Invalid token');
          return;
        }
        ws.sessionId = user.sid;
        if (user.pending) {
          ws.pendingUserId = String(user.id);
          if (!pendingClients.has(ws.pendingUserId)) pendingClients.set(ws.pendingUserId, []);
          pendingClients.get(ws.pendingUserId).push(ws);
          return;
        }
        addClient(ws, user.id);
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
          reactionPushes: data.reactionPushes === true,
          activeUntil: now + idleIn,
          at: now,
        };
        if (ws.userId) refreshStatus(ws.userId);
      } else if (data.type === 'activity') {
        // What this device's games say you're doing (the desktop app's Rich Presence), or [].
        if (!ws.userId) return;
        const now = Date.now();
        if (!ws.activityWindow || now - ws.activityWindow.start > 60000) ws.activityWindow = { start: now, count: 0 };
        if (++ws.activityWindow.count > ACTIVITY_SETS_PER_MINUTE) return;
        ws.activities = activities.cleanActivities(data.activities);
        ws.activitiesAt = now;
        refreshActivities(ws.userId);
      }
    });

    ws.on('close', () => {
      const { userId } = ws;
      if (ws.pendingUserId) removeFrom(pendingClients, ws.pendingUserId, ws);
      if (!userId || !clients.has(userId)) return;
      removeFrom(clients, userId, ws);
      refreshStatus(userId);
      if (ws.activities?.length) refreshActivities(userId);
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
  clients, pendingClients, approvePendingSockets, closePendingSockets, sendToUserSockets, sendToAllSockets, sendToDesktopSockets, getStatus, refreshStatus, refreshActivities, isViewingConversation, attachWebSocketServer,
};
