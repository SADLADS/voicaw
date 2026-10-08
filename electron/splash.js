// The splash window shown while the app starts (as Discord's): the bird in a ring, then one line
// saying what's happening. Looking for an update, downloading one (the ring fills with its
// progress, and after a while "Start anyway" appears), installing it, then starting while the
// main window loads. Its page is assets/splash.html, with no access to anything but
// splashPreload.js.
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const WIDTH = 300;
const HEIGHT = 340;
// How long a download runs before "Start anyway" is offered.
const OFFER_START_AFTER_MS = 10000;

// What the window shows for an updater status (updater.js `launch`): its page draws these.
function splashView(status) {
    const { state, version } = status ?? {};
    switch (state) {
        case 'checking': return { ring: 'spin', text: 'Checking for updates' };
        case 'downloading': return { ring: 'progress', text: 'Downloading update', detail: version ? `Version ${version}` : '' };
        case 'installing': return { ring: 'spin', text: 'Installing update', detail: version ? `Version ${version}` : '' };
        default: return { ring: 'spin', text: 'Starting' };
    }
}

function createSplash({ icon, onStartAnyway = () => {} }) {
    // Rounded corners need a transparent window; Linux only has one with a compositor, so it
    // gets square ones (the page draws its card square too).
    const transparent = process.platform !== 'linux';
    const win = new BrowserWindow({
        icon,
        width: WIDTH,
        height: HEIGHT,
        frame: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        center: true,
        show: false,
        transparent,
        backgroundColor: transparent ? '#00000000' : '#17151d',
        title: 'Voicaw',
        webPreferences: {
            preload: path.join(__dirname, 'splashPreload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    let offerTimer = null;
    const fromSplash = (event) => !win.isDestroyed() && event.sender === win.webContents;
    const startAnyway = (event) => { if (fromSplash(event)) onStartAnyway(); };
    ipcMain.on('splash:start-anyway', startAnyway);

    let shown = splashView();
    const send = (channel, value) => { if (!win.isDestroyed()) win.webContents.send(channel, value); };
    win.webContents.on('did-finish-load', () => send('splash:view', shown));
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
        clearTimeout(offerTimer);
        ipcMain.removeListener('splash:start-anyway', startAnyway);
    });
    win.loadFile(path.join(__dirname, 'assets', 'splash.html'), transparent ? {} : { search: 'square' });

    return {
        window: win,
        // An updater status (or nothing: starting).
        status(status) {
            shown = splashView(status);
            send('splash:view', shown);
            clearTimeout(offerTimer);
            if (status?.state === 'downloading') {
                offerTimer = setTimeout(() => send('splash:offer-start', true), OFFER_START_AFTER_MS);
            }
        },
        progress(fraction) { send('splash:progress', fraction); },
        close() { if (!win.isDestroyed()) win.close(); },
    };
}

module.exports = { createSplash, splashView };
