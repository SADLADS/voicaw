import { applyPresenceSnapshot, applyUserStatus, isMobileDevice, resetPresence } from './presence';
import { mergeProfiles } from './profiles';
import { desktopNotificationsOn } from '../services/pushService';

let ws;
let token;
const newDmlisteners = new Set();
const deleteListeners = new Set();
const editListeners = new Set();
const reactionAddListeners = new Set();
const reactionRemoveListeners = new Set();
const dmPinListeners = new Set();
const guildListeners = new Set();
const callListeners = new Set();
const groupListeners = new Set();
const notificationListeners = new Set();
let reconnectTimeout = null;

// This client's own connection: 'connecting' | 'online' | 'offline' (logged out, or the
// device has no network). Shown in the user panel.
let connectionState = 'offline';
const connectionListeners = new Set();

function setConnectionState(next) {
  if (next === connectionState) return;
  connectionState = next;
  connectionListeners.forEach((cb) => cb(next));
}

export function getConnectionState() {
  return connectionState;
}

export function onConnectionState(callback) {
  connectionListeners.add(callback);
  return () => connectionListeners.delete(callback);
}

// Presence: tells the server whether this client is on screen and which conversation it
// shows, so it can skip push notifications for a chat the user is already reading.
// Re-sent periodically because the server ignores stale presence (a phone that locks may
// never get to report going hidden). It also carries what the online status is worked out
// from: whether this is a phone, and how long until this device counts as idle (no input
// here for IDLE_AFTER_MS; on a phone, also as soon as the app is hidden).
const PRESENCE_REFRESH_MS = 15000;
const IDLE_AFTER_MS = 10 * 60 * 1000;
const mobileDevice = isMobileDevice();
let activeChatId = null;
let presenceInterval = null;
let lastActivity = Date.now();

function idleIn() {
  if (mobileDevice && typeof document !== 'undefined' && document.visibilityState !== 'visible') return 0;
  return Math.max(0, lastActivity + IDLE_AFTER_MS - Date.now());
}

function sendPresence() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const visible = typeof document === 'undefined' ||
    (document.visibilityState === 'visible' && document.hasFocus());
  ws.send(JSON.stringify({
    type: 'presence', visible, chatId: activeChatId, mobile: mobileDevice, idleIn: idleIn(),
    // The desktop app gets its notifications here instead of by web push (see onNotification).
    desktopNotifications: desktopNotificationsOn(),
  }));
}

// Input (or coming back to the app): active again, which the server hears at once if this
// device had gone idle.
function noteActivity() {
  const wasIdle = idleIn() === 0;
  lastActivity = Date.now();
  if (wasIdle) sendPresence();
}

export function setActiveChat(chatId) {
  activeChatId = chatId != null ? String(chatId) : null;
  sendPresence();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('offline', () => { if (ws) setConnectionState('offline'); });
  window.addEventListener('online', () => {
    if (ws) setConnectionState(ws.readyState === WebSocket.OPEN ? 'online' : 'connecting');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lastActivity = Date.now();
    sendPresence();
  });
  window.addEventListener('focus', () => {
    lastActivity = Date.now();
    sendPresence();
  });
  window.addEventListener('blur', sendPresence);
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, noteActivity, { capture: true, passive: true });
  }
}

export function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.warn('[WS] Already connected');
    return;
  }

  token = localStorage.getItem('token');
  if (!token) {
    console.warn('[WS] No JWT token found, not connecting');
    return;
  }

  const url = import.meta.env.VITE_WS_URL;
  console.log("Connecting to WebSocket:", url);
  const socket = new WebSocket(url);
  ws = socket;
  setConnectionState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting');

  ws.onopen = () => {
    setConnectionState('online');
    console.log('[WS] Connection opened');
    // Presence first, so the server already knows this device's status when it identifies.
    sendPresence();
    ws.send(JSON.stringify({ type: 'identify', token }));
    clearInterval(presenceInterval);
    presenceInterval = setInterval(sendPresence, PRESENCE_REFRESH_MS);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'new_dm') {
        newDmlisteners.forEach((cb) => cb(data.message));
      }
      else if (data.type === 'delete_dm') {
        deleteListeners.forEach((cb) => cb(data));
      }
      else if (data.type === 'edit_dm') {
        editListeners.forEach((cb) => cb(data));
      }
      else if (data.type === 'reaction_add') {
        reactionAddListeners.forEach((cb) => cb(data.reaction));
      }
      else if (data.type === 'reaction_remove') {
        reactionRemoveListeners.forEach((cb) => cb(data));
      }
      else if (data.type === 'dm_pin') {
        dmPinListeners.forEach((cb) => cb(data));
      }
      else if (data.type?.startsWith('guild_')) {
        guildListeners.forEach((cb) => cb(data));
      }
      else if (data.type?.startsWith('call_')) {
        callListeners.forEach((cb) => cb(data));
      }
      else if (data.type?.startsWith('group_dm_')) {
        groupListeners.forEach((cb) => cb(data));
      }
      else if (data.type === 'notification') {
        notificationListeners.forEach((cb) => cb(data.payload));
      }
      else if (data.type === 'user_profile') {
        mergeProfiles([data.user]);
      }
      else if (data.type === 'user_status') {
        applyUserStatus(data);
      }
      else if (data.type === 'presence_snapshot') {
        applyPresenceSnapshot(data.statuses);
      }
    } catch (err) {
      console.error('[WS] Failed to parse or handle message:', err);
    }
  };

  ws.onclose = (event) => {
    // A socket closed on purpose (logout) or already replaced: nothing to do.
    if (socket !== ws) return;
    clearInterval(presenceInterval);
    setConnectionState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting');
    console.warn(`[WS] Connection closed. Code: ${event.code}, Reason: "${event.reason || 'No reason'}"`);

    // Try to reconnect after short delay
    reconnectTimeout = setTimeout(() => {
      console.log('[WS] Attempting reconnect...');
      connectWebSocket(); // uses token from localStorage
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] WebSocket error:', err);
  };
}

export function closeWebSocket() {
  clearInterval(presenceInterval);
  activeChatId = null;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close(1000, 'Client logout');
  }
  setConnectionState('offline');
  resetPresence();
  newDmlisteners.clear();
  deleteListeners.clear();
  editListeners.clear();
  reactionAddListeners.clear();
  reactionRemoveListeners.clear();
  dmPinListeners.clear();
  guildListeners.clear();
}

// The desktop app's notifications: what would be a web push, as its payload.
export function onNotification(callback) {
  notificationListeners.add(callback);
  return () => notificationListeners.delete(callback);
}

// Tells the server again whether to send this device notifications (after turning them on or off).
export function refreshPresence() {
  sendPresence();
}

export function onNewDm(callback) {
  newDmlisteners.add(callback);
  return () => newDmlisteners.delete(callback);
}

export function onDeleteDm(callback) {
  deleteListeners.add(callback);
  return () => deleteListeners.delete(callback);
}

export function onEditDm(callback) {
  editListeners.add(callback);
  return () => editListeners.delete(callback);
}

// A reaction row ({ id, message_id, user_id, content }) was added to a DM.
export function onReactionAdd(callback) {
  reactionAddListeners.add(callback);
  return () => reactionAddListeners.delete(callback);
}

// { reactionId, messageId }
export function onReactionRemove(callback) {
  reactionRemoveListeners.add(callback);
  return () => reactionRemoveListeners.delete(callback);
}

// A DM was pinned or unpinned: { messageId, sender_id, recipient_id, pinned_at, pinned_by }
// (pinned_at null: unpinned).
export function onDmPin(callback) {
  dmPinListeners.add(callback);
  return () => dmPinListeners.delete(callback);
}

// Every guild event, as sent by the server: `{ type: 'guild_add' | 'guild_update' |
// 'guild_remove' | 'guild_member_add' | 'guild_member_remove' | 'guild_message_new' |
// 'guild_message_edit' | 'guild_message_delete' | 'guild_reaction_add' |
// 'guild_reaction_remove' | 'guild_message_pin' | 'guild_voice_state' | 'guild_mention', ... }` (see CLAUDE.md, Guilds).
export function onGuildEvent(callback) {
  guildListeners.add(callback);
  return () => guildListeners.delete(callback);
}

// DM call events: `{ type: 'call_incoming' | 'call_update', call }` and
// `{ type: 'call_end', id, reason }` (see voice/callClient.js).
export function onCallEvent(callback) {
  callListeners.add(callback);
  return () => callListeners.delete(callback);
}

// Group DM events: `group_dm_add` / `_update` ({ group, entry? }), `_remove` ({ groupId }),
// `_epoch` ({ groupId, epoch }), `_message_new` / `_edit` / `_delete` / `_pin`, `_reaction_add` /
// `_remove` (see server/routes/groupDms.js).
export function onGroupEvent(callback) {
  groupListeners.add(callback);
  return () => groupListeners.delete(callback);
}
