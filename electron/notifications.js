// System notifications for the desktop app. The page gets them over the websocket (whatever
// would be a web push, see server/push.js), works out the text (decrypting DM previews on the
// device, as the service worker does) and hands them here. One per `tag`: a newer one
// replaces the last, and reading that chat anywhere takes it down (`close`). Clicking one opens the window on its chat. They're silent: the page
// plays the app's own sounds (client sounds/), which the user can turn off there.
const { Notification, nativeImage } = require('electron');

const MAX_TITLE = 200;
const MAX_BODY = 500;
const MAX_ICON_DATA_URL = 2 * 1024 * 1024;

// The notification's fields from the page, checked (it's page input to the main process).
function cleanNotification(input) {
    if (!input || typeof input !== 'object') return null;
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
    const title = text(input.title, MAX_TITLE) || 'Voicaw';
    const url = typeof input.url === 'string' && input.url.startsWith('/') && !input.url.startsWith('//') ? input.url : '/';
    const icon = typeof input.icon === 'string' && input.icon.startsWith('data:image/') && input.icon.length <= MAX_ICON_DATA_URL
        ? input.icon : null;
    return {
        title,
        body: text(input.body, MAX_BODY),
        url,
        icon,
        tag: typeof input.tag === 'string' ? input.tag.slice(0, 100) : null,
    };
}

function createNotifier({ onClick }) {
    const byTag = new Map();

    function show(input) {
        const n = cleanNotification(input);
        if (!n || !Notification.isSupported()) return;
        if (n.tag) byTag.get(n.tag)?.close();
        const notification = new Notification({
            title: n.title,
            body: n.body,
            icon: n.icon ? nativeImage.createFromDataURL(n.icon) : undefined,
            silent: true,
        });
        notification.on('click', () => onClick(n.url));
        notification.on('close', () => {
            if (n.tag && byTag.get(n.tag) === notification) byTag.delete(n.tag);
        });
        if (n.tag) byTag.set(n.tag, notification);
        notification.show();
    }

    function close(tag) {
        if (typeof tag !== 'string') return;
        byTag.get(tag)?.close();
        byTag.delete(tag);
    }

    return { show, close };
}

module.exports = { createNotifier, cleanNotification };
