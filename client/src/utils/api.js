import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,
});

console.log('API Base URL:', import.meta.env.VITE_API_BASE_URL);
console.log('All env:', import.meta.env);

export default api;