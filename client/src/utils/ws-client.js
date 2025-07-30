let ws;
let token;
const listeners = new Set();

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
    } catch (err) {
      console.error('[WS] Failed to parse or handle message:', err);
    }
  };

  ws.onclose = (event) => {
    console.warn(`[WS] Connection closed. Code: ${event.code}, Reason: "${event.reason || 'No reason'}"`);

    // Try to reconnect after short delay
    setTimeout(() => {
      console.log('[WS] Attempting reconnect...');
      connectWebSocket(); // uses token from localStorage
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] WebSocket error:', err);
  };
}

export function onNewDm(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
