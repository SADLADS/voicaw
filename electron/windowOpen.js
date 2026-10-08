// The windows the page may open (setWindowOpenHandler), by their names (client
// voice/popoutWindow.js): the popped-out screen share, a blank window the page draws the stream
// into itself, and Watch Together's popped-out player, the app's own popout.html (YouTube's
// player needs a real page for its Referer) that the page draws into likewise. Links to other
// sites open in the browser; anything else is refused.
const { ORIGIN } = require('./protocol');

const STREAM_WINDOW_NAME = 'voicaw-stream';
const WATCH_PARTY_WINDOW_NAME = 'voicaw-watch-together';
const POPOUT_PAGE = `${ORIGIN}/popout.html`;

function popout(icon, title) {
    return {
        action: 'allow',
        overrideBrowserWindowOptions: {
            icon,
            title,
            minWidth: 320,
            minHeight: 200,
            backgroundColor: '#000000',
            autoHideMenuBar: true,
        },
    };
}

function windowOpenAction({ url, frameName }, { icon, openExternal }) {
    if (frameName === STREAM_WINDOW_NAME && url === 'about:blank') return popout(icon, 'Stream – Voicaw');
    if (frameName === WATCH_PARTY_WINDOW_NAME && url === POPOUT_PAGE) return popout(icon, 'Watch Together – Voicaw');
    if (/^(https?:|mailto:)/.test(url)) openExternal(url);
    return { action: 'deny' };
}

// What a popped-out window may ask for: only full screen (the stream's page is about:blank, so
// the app's own pages' check, by URL, doesn't cover it; neither may anything in a window).
function streamWindowPermission(permission) {
    return permission === 'fullscreen';
}

module.exports = { STREAM_WINDOW_NAME, WATCH_PARTY_WINDOW_NAME, windowOpenAction, streamWindowPermission };
