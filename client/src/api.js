import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,
});

console.log('API Base URL:', import.meta.env.VITE_API_BASE_URL);


export default api;

let ws;
let userId;
const listeners = new Set();

export function connectWebSocket(currentUserId) {
  userId = currentUserId.toString();
  ws = new WebSocket(import.meta.env.VITE_VITE_WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connection opened');
    ws.send(JSON.stringify({ type: 'identify', userId }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'new_dm') {
      console.log('New DM event:', data.message);
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
