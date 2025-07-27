let ws;
let userId;
const listeners = new Set();

export function connectWebSocket(currentUserId) {
  if (currentUserId) {
    userId = currentUserId.toString();
  }

  console.log("WS URL:", import.meta.env.VITE_WS_URL);
  ws = new WebSocket(import.meta.env.VITE_WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connection opened');
    ws.send(JSON.stringify({ type: 'identify', userId }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'new_dm') {
      listeners.forEach((cb) => cb(data.message));
    }
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed, reconnecting in 3 seconds...');
    setTimeout(() => connectWebSocket(), 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    ws.close(); // force close to trigger reconnect logic
  };
}

// Subscribe to new DM events
export function onNewDm(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback); // unsubscribe
}
