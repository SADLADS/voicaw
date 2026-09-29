import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './AuthProvider.jsx';
import { registerSW } from 'virtual:pwa-register';
import { setUpdateAvailable, watchForUpdates, watchForStaleApp } from './utils/appUpdate';


// Import Bootstrap CSS
import 'bootstrap/dist/css/bootstrap.min.css';

// Global css
import './assets/css/voicaw.css';
import App from './App.jsx';

// A new version waits until the user chooses to update (UpdateBanner, Settings).
const updateSW = registerSW({
  onNeedRefresh() {
    setUpdateAvailable(() => updateSW(true));
  },
  onRegisteredSW(swUrl, registration) {
    if (registration) watchForUpdates(registration);
  },
});
watchForStaleApp();

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);