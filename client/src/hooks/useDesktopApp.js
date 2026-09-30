import { useEffect } from 'react';
import { desktop, unreadSummary } from '../utils/desktop';
import { onNotification } from '../utils/ws-client';
import { notificationFromPush } from '../services/pushNotifications';
import { getVoiceSnapshot, setSelfDeaf, setSelfMute } from '../voice/voiceClient';

// The desktop app's side of the logged-in page (from Layout); does nothing in a browser:
// - notifications: the server sends it what would be a web push; the text is worked out
//   exactly as the service worker does (DM previews decrypted here, on the device), and the
//   app shows it. Clicking one opens its chat (`navigate`).
// - the unread count on the tray icon and taskbar/dock
// - the global mute / deafen shortcuts
export function useDesktopApp({ navigate, unreadDms, groups, guildUnread }) {
  useEffect(() => {
    if (!desktop) return undefined;
    const stopNotifications = onNotification(async (payload) => {
      try {
        const { title, options } = await notificationFromPush(payload);
        desktop.notify({
          title,
          body: options.body,
          tag: options.tag,
          url: options.data?.url,
          icon: await imageDataUrl(options.icon),
        });
      } catch (err) {
        console.warn('Could not show a notification', err);
      }
    });
    const stopNavigate = desktop.onNavigate((url) => navigate(url));
    const stopShortcut = desktop.onShortcut((action) => {
      const { selfMute, selfDeaf } = getVoiceSnapshot();
      if (action === 'toggleMute') setSelfMute(!(selfMute || selfDeaf));
      else if (action === 'toggleDeafen') setSelfDeaf(!selfDeaf);
    });
    return () => {
      stopNotifications();
      stopNavigate();
      stopShortcut();
    };
  }, [navigate]);

  const { count, dot } = unreadSummary({ unreadDms, groups, guildUnread });
  useEffect(() => {
    desktop?.setUnread({ count, dot });
  }, [count, dot]);

  // Logged out: nothing unread.
  useEffect(() => () => desktop?.setUnread({ count: 0, dot: false }), []);
}

// The notification's picture as a data URL (the app's main process can't fetch it with the
// page's access); the app's logo if it can't be loaded.
async function imageDataUrl(url) {
  for (const src of [url, '/logo192.png']) {
    if (!src) continue;
    try {
      const response = await fetch(src);
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) continue;
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      // try the next one
    }
  }
  return null;
}
