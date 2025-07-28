let ws;
let userId;
const listeners = new Set(); // all subscribed components will receive every new message

export function connectWebSocket(currentUserId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.warn('[WS] Already connected');
    return;
  }

  if (currentUserId) userId = currentUserId.toString();

  const url = import.meta.env.VITE_WS_URL;
  console.log("Connecting to WebSocket:", url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connection opened');
    ws.send(JSON.stringify({ type: 'identify', userId }));
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

    // Reconnect after delay
    setTimeout(() => {
      console.log('[WS] Attempting reconnect...');
      connectWebSocket(userId);
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] WebSocket error:', err);
  };
}

// Subscribe to new DM messages (global event)
export function onNewDm(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback); // unsubscribe
}
