let ws;
let userId;
const listeners = new Set();

export function connectWebSocket(currentUserId) {
  console.log("WS URL:", import.meta.env.VITE_WS_URL);
  userId = currentUserId.toString();
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

  ws.onclose = () => {
    console.log('WebSocket connection closed');
  };
}

// Subscribe to new DM events
export function onNewDm(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback); // unsubscribe
}
