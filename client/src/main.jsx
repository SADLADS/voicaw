import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './AuthProvider.jsx';
import { registerSW } from 'virtual:pwa-register';
import { setUpdateAvailable, watchDesktopUpdates, watchForUpdates, watchForStaleApp } from './utils/appUpdate';
import { desktop } from './utils/desktop';
import { applySpellcheck } from './utils/spellcheck';


// Import Bootstrap CSS
import 'bootstrap/dist/css/bootstrap.min.css';

// Global css
import './assets/css/voicaw.css';
import './assets/css/twemoji-font.css';
import App from './App.jsx';

// A new version waits until the user chooses to update (UpdateBanner, Settings). The desktop
// app ships its page inside itself and updates as a whole (electron/updater.js), so it has no
// service worker.
if (desktop) {
  watchDesktopUpdates(desktop);
} else {
  const updateSW = registerSW({
    onNeedRefresh() {
      setUpdateAvailable(() => updateSW(true));
    },
    onRegisteredSW(swUrl, registration) {
      if (registration) watchForUpdates(registration);
    },
  });
}
watchForStaleApp();
applySpellcheck();

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);