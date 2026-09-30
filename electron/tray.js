// The tray icon (open, quit; a red dot on it while something's unread) and the unread badge on
// the taskbar or dock. The page tells us what's unread: `count` (DMs, group messages and
// mentions, what Discord counts) and `dot` (anything unread at all).
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

const ICON = path.join(__dirname, 'assets', 'icon.png');
const DOT_COLOR = [0xed, 0x42, 0x45]; // r, g, b

// Paints a red dot (with a thin transparent ring) in the bottom right corner of a BGRA
// bitmap of `size`×`size`, in place. Returns the bitmap.
function paintDot(bitmap, size, radiusShare = 0.3) {
    const r = size * radiusShare;
    const cx = size - r;
    const cy = size - r;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            const i = (y * size + x) * 4;
            if (d <= r - 1) {
                bitmap[i] = DOT_COLOR[2];
                bitmap[i + 1] = DOT_COLOR[1];
                bitmap[i + 2] = DOT_COLOR[0];
                bitmap[i + 3] = 255;
            } else if (d <= r + 1) {
                bitmap[i + 3] = 0; // the ring, so the dot stands off the icon
            }
        }
    }
    return bitmap;
}

function iconImage(size, dot) {
    const image = nativeImage.createFromPath(ICON).resize({ width: size, height: size, quality: 'best' });
    if (!dot) return image;
    const bitmap = paintDot(Buffer.from(image.toBitmap()), size);
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

// A plain red dot, for the Windows taskbar overlay.
function dotImage(size = 16) {
    return nativeImage.createFromBitmap(paintDot(Buffer.alloc(size * size * 4), size, 0.5), { width: size, height: size });
}

function unreadLabel({ count, dot }) {
    if (count > 0) return `Voicaw: ${count} unread`;
    return dot ? 'Voicaw: unread messages' : 'Voicaw';
}

function createTray({ showWindow, quit }) {
    const size = process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 22;
    const tray = new Tray(iconImage(size, false));
    tray.setToolTip('Voicaw');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Voicaw', click: showWindow },
        { type: 'separator' },
        { label: 'Quit Voicaw', click: quit },
    ]));
    // Linux and Windows open on a click (macOS shows the menu).
    tray.on('click', showWindow);

    let shown = { count: 0, dot: false };
    function setUnread(win, unread) {
        const next = { count: Math.max(0, Math.floor(Number(unread?.count) || 0)), dot: Boolean(unread?.dot || unread?.count) };
        if (next.count === shown.count && next.dot === shown.dot) return;
        shown = next;
        tray.setImage(iconImage(size, next.dot));
        tray.setToolTip(unreadLabel(next));
        if (process.platform === 'darwin') {
            app.dock?.setBadge(next.count ? String(next.count) : next.dot ? '•' : '');
        } else if (process.platform === 'win32') {
            win?.setOverlayIcon(next.dot ? dotImage() : null, unreadLabel(next));
        } else {
            app.setBadgeCount(next.count); // Unity / KDE launchers
        }
    }

    return { tray, setUnread };
}

module.exports = { createTray, paintDot, unreadLabel };
