import { notificationFromPush } from '../services/pushNotifications';
import { declineCallRequest } from '../services/callService';
import { t } from '../i18n';

// The Android app's hidden page (notify.html). When a push arrives the app may not be
// running, so it loads this page in an invisible WebView (mobile/android/.../NotifyRenderer.java)
// and asks it to word the notification, exactly as the service worker does for web push: DM
// and group previews are decrypted here, with the keys this phone's app already keeps (same
// origin, same storage), never a key from the push. It also declines calls from the call
// notification, with the app's login.
//
// The app calls `voicawNotify.run(id, request)` and gets the answer back through the
// `VoicawNotifyHost` bridge as `result(id, json)`.

const handlers = {
  async render({ payload }) {
    const notification = await notificationFromPush(payload);
    // A reaction not to show (a poll vote, or one that won't open): Notifications.java drops it.
    if (!notification) return { skip: true };
    const { title, options } = notification;
    return {
      title,
      body: options.body,
      tag: options.tag,
      url: options.data?.url ?? '/',
      icon: options.icon ? new URL(options.icon, location.href).href : null,
      labels: {
        answer: t('calls.incoming.accept'),
        decline: t('calls.incoming.decline'),
        incomingCall: t('calls.incoming.voiceCall'),
        groupCall: t('calls.incoming.groupCall'),
      },
    };
  },
  async decline({ callId }) {
    await declineCallRequest(callId);
    return {};
  },
};

window.voicawNotify = {
  async run(id, request) {
    let reply;
    try {
      reply = { ok: true, ...(await handlers[request.type](request)) };
    } catch (err) {
      reply = { ok: false, error: String(err?.message || err) };
    }
    window.VoicawNotifyHost?.result(id, JSON.stringify(reply));
  },
};
window.VoicawNotifyHost?.ready();
