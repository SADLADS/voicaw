// src/api.js
import axios from 'axios';

const api = axios.create({
  baseURL: 'https://voicaw.com/api',
  withCredentials: true,  // <-- this ensures cookies (sessions) sent on all requests
});

export default api;
