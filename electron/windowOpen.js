// The windows the page may open (setWindowOpenHandler). Only one: the popped-out screen share
// (client voice/streamWindow.js), a blank window, by its name, that the page draws the stream
// into itself. Links to other sites open in the browser; anything else is refused.
const STREAM_WINDOW_NAME = 'voicaw-stream';

function windowOpenAction({ url, frameName }, { icon, openExternal }) {
    if (frameName === STREAM_WINDOW_NAME && url === 'about:blank') {
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                icon,
                title: 'Stream – Voicaw',
                minWidth: 320,
                minHeight: 200,
                backgroundColor: '#000000',
                autoHideMenuBar: true,
            },
        };
    }
    if (/^(https?:|mailto:)/.test(url)) openExternal(url);
    return { action: 'deny' };
}

// What the stream window may ask for: only full screen (its page is about:blank, so the
// app's own pages' check, by URL, doesn't cover it).
function streamWindowPermission(permission) {
    return permission === 'fullscreen';
}

module.exports = { STREAM_WINDOW_NAME, windowOpenAction, streamWindowPermission };
