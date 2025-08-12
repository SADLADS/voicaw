let ws;
let token;
const listeners = new Set();
const statusListeners = new Set();
let reconnectTimeout = null;

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
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'new_dm') {
        listeners.forEach((cb) => cb(data.message));
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
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (ws) {
    ws.close(1000, 'Client logout');
    ws = null;
  }
  listeners.clear();
  statusListeners.clear();
}

export function onNewDm(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function onUserStatus(callback) {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}