let ws;
let token;
const newDmlisteners = new Set();
const deleteListeners = new Set();
const editListeners = new Set();
const statusListeners = new Set();
const reactionAddListeners = new Set();
const reactionRemoveListeners = new Set();
let reconnectTimeout = null;

// Presence: tells the server whether this client is on screen and which conversation it
// shows, so it can skip push notifications for a chat the user is already reading.
// Re-sent periodically because the server ignores stale presence (a phone that locks may
// never get to report going hidden).
const PRESENCE_REFRESH_MS = 15000;
let activeChatId = null;
let presenceInterval = null;

function sendPresence() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const visible = typeof document === 'undefined' ||
    (document.visibilityState === 'visible' && document.hasFocus());
  ws.send(JSON.stringify({ type: 'presence', visible, chatId: activeChatId }));
}

export function setActiveChat(chatId) {
  activeChatId = chatId != null ? String(chatId) : null;
  sendPresence();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', sendPresence);
  window.addEventListener('focus', sendPresence);
  window.addEventListener('blur', sendPresence);
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
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connection opened');
    // Identify using JWT token
    ws.send(JSON.stringify({ type: 'identify', token }));
    sendPresence();
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
      else if (data.type === 'user_status') {
        console.log(`User ${data.userId} is now ${data.status}`);
        statusListeners.forEach((cb) => cb(data));
      }
    } catch (err) {
      console.error('[WS] Failed to parse or handle message:', err);
    }
  };

  ws.onclose = (event) => {
    clearInterval(presenceInterval);
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
    ws.close(1000, 'Client logout');
    ws = null;
  }
  newDmlisteners.clear();
  statusListeners.clear();
  deleteListeners.clear();
  editListeners.clear();
  reactionAddListeners.clear();
  reactionRemoveListeners.clear();
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

export function onUserStatus(callback) {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
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
