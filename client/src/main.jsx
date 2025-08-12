import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './AuthProvider.jsx';

// Import Bootstrap CSS
import 'bootstrap/dist/css/bootstrap.min.css';

// Global css
import './assets/css/voicaw.css';
import App from './App.jsx';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js');
      console.log('Service worker registered:', reg);
    } catch (err) {
      console.error('Service worker registration failed:', err);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);