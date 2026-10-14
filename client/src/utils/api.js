import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

// The saved login, unless the request already says which one (logout's last requests carry
// the token being logged out: sent late, after logging in again, they'd otherwise end the new
// session).
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// The server sends a new login token once the current one is a day old (server/auth.js),
// so a session lasts as long as the app is used. It's only kept if it renews the token this
// request was sent with: not after a logout, or once someone else has logged in.
api.interceptors.response.use(res => {
  const renewed = res.headers?.['x-voicaw-token'];
  const sentWith = res.config?.headers?.Authorization;
  if (renewed && sentWith && sentWith === `Bearer ${localStorage.getItem('token')}`) {
    localStorage.setItem('token', renewed);
  }
  return res;
});

console.log('API Base URL:', import.meta.env.VITE_API_BASE_URL);

export default api;