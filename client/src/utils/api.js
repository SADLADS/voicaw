import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token'); // or wherever you store the token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

console.log('API Base URL:', import.meta.env.VITE_API_BASE_URL);

export default api;