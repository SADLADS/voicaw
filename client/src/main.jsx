// Font Awesome's icon CSS (components/Icon.jsx), first so the app's own CSS can override it.
import '@fortawesome/fontawesome-svg-core/styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './AuthProvider.jsx';
import { registerSW } from 'virtual:pwa-register';
import { setUpdateAvailable, watchAndroidUpdates, watchDesktopUpdates, watchForUpdates, watchForStaleApp } from './utils/appUpdate';
import { desktop } from './utils/desktop';
import { android, isAndroidApp, refreshAndroidNotificationState } from './utils/android';
import { applySpellcheck } from './utils/spellcheck';
import { applyTheme } from './utils/theme';
import { applyMessageDisplay } from './utils/messageDisplay';
import { blockNativeContextMenu } from './utils/nativeContextMenu';


// Import Bootstrap CSS
import 'bootstrap/dist/css/bootstrap.min.css';

// The app's typeface, bundled so the desktop and Android apps have it offline (twemoji-font.css).
import '@fontsource-variable/figtree';

// Global css
import './assets/css/voicaw.css';
import './assets/css/twemoji-font.css';
import App from './App.jsx';

// A new version waits until the user chooses to update (UpdateBanner, Settings). The desktop
// app ships its page inside itself and updates as a whole (electron/updater.js), so it has no
// service worker. Neither does the Android app (its page ships in the APK, which updates
// itself unless it came from Google Play).
if (desktop) {
  watchDesktopUpdates(desktop);
} else if (isAndroidApp()) {
  watchAndroidUpdates(android);
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
applyTheme();
applyMessageDisplay();
blockNativeContextMenu();

// The Android app first asks Android about notifications (one quick call), so the first
// render already knows (getPushStatus is synchronous: the "turn on notifications" prompt).
const nativeReady = isAndroidApp() ? refreshAndroidNotificationState() : Promise.resolve();
nativeReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
});