import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './AuthProvider.jsx';
import { registerSW } from 'virtual:pwa-register';


// Import Bootstrap CSS
import 'bootstrap/dist/css/bootstrap.min.css';

// Global css
import './assets/css/voicaw.css';
import App from './App.jsx';

const updateSW = registerSW({
  onNeedRefresh() {},
  onOfflineReady() {},
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);