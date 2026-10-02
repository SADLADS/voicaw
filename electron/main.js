// The desktop app: one window showing the client build that ships inside the app (see
// protocol.js), plus what a browser tab can't do: notifications without web push, a tray
// icon with the unread count, closing to the tray, starting at login, global mute/deafen
// shortcuts, a screen picker for screen sharing and updating itself. The page reaches these through preload.js.
const path = require('path');
const { app, BrowserWindow, Menu, desktopCapturer, globalShortcut, ipcMain, net, protocol, screen, session, shell } = require('electron');
const { setUpSpellcheck } = require('./spellcheck');
const { ORIGIN, registerScheme, handleScheme } = require('./protocol');
const { createSettingsStore } = require('./desktopSettings');
const { createTray } = require('./tray');
const { createNotifier } = require('./notifications');
const { applyShortcuts } = require('./shortcuts');
const { createUpdater } = require('./updater');
const { setStartAtLogin, startedHidden } = require('./autoStart');
const { createScreenShare } = require('./screenShare');

const APP_ID = 'com.voicaw.app';
const BUILD_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '../build');
// Only the app's own pages get these (microphone, notifications, copying, full screen video,
// and screen capture, which only ever gets what the person picked in our picker).
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']);

registerScheme(protocol);

let win = null;
let quitting = false;
let settings;
let tray;
let notifier;
let updater;
let screenShare;

// One app at a time: starting it again brings the running one forward.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // notifications need it
    app.whenReady().then(start);
}

const fromApp = (event) => (event.senderFrame?.url ?? '').startsWith(`${ORIGIN}/`);

function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function quit() {
    quitting = true;
    app.quit();
}

// The last window position, if it's still on a screen (else just its size).
function savedBounds() {
    const saved = settings.get().window;
    if (!saved?.width || !saved?.height) return {};
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y);
    const { x, y, width, height } = saved;
    return onScreen ? { x, y, width, height } : { width, height };
}

function rememberBounds() {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    settings.setWindow({ ...(maximized ? settings.get().window : win.getBounds()), maximized });
}

function createWindow(hidden) {
    win = new BrowserWindow({
        icon: path.join(__dirname, 'assets', 'icon.png'),
        width: 1200,
        height: 800,
        minWidth: 480,
        minHeight: 400,
        ...savedBounds(),
        show: false,
        backgroundColor: '#17151d',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
            // Ringing, voice and the websocket carry on normally while it's in the tray.
            backgroundThrottling: false,
        },
    });
    setUpSpellcheck(win);
    if (settings.get().window?.maximized) win.maximize();

    if (process.platform === 'darwin') {
        // macOS needs a menu for copy/paste shortcuts to work.
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    } else {
        win.removeMenu();
    }

    win.once('ready-to-show', () => { if (!hidden) win.show(); });

    // Links to other sites open in the browser; the window only ever shows the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(`${ORIGIN}/`)) return;
        event.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
    });
    // Developer tools only in a development run (Ctrl+Shift+I, Cmd+Option+I).
    if (!app.isPackaged) {
        win.webContents.on('before-input-event', (event, input) => {
            if (input.type === 'keyDown' && input.key.toLowerCase() === 'i' && (input.control || input.meta) && (input.shift || input.alt)) {
                win.webContents.toggleDevTools();
            }
        });
    }

    // Closing leaves it running in the tray (on macOS always, as apps there do), unless quitting.
    win.on('close', (event) => {
        rememberBounds();
        if (!quitting && (settings.get().closeToTray || process.platform === 'darwin')) {
            event.preventDefault();
            win.hide();
        }
    });
    win.on('closed', () => { win = null; });

    win.loadURL(`${ORIGIN}/`);
}

function setUpPermissions() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const ours = (details.requestingUrl ?? '').startsWith(`${ORIGIN}/`);
        // The microphone, not the camera (screen capture goes through the handler below).
        const audioOnly = permission !== 'media' || !details.mediaTypes?.includes('video');
        callback(ours && ALLOWED_PERMISSIONS.has(permission) && audioOnly);
    });
    ses.setDisplayMediaRequestHandler((request, callback) => screenShare.handleRequest(request, callback));
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
        requestingOrigin === ORIGIN && ALLOWED_PERMISSIONS.has(permission));
}

// Returns the actions whose key couldn't be registered.
function applyDesktopShortcuts() {
    return applyShortcuts(settings.get().shortcuts, (action) => win?.webContents.send('desktop:shortcut', action));
}

function setUpIpc() {
    ipcMain.handle('desktop:info', (event) => (fromApp(event) ? { version: app.getVersion(), packaged: app.isPackaged } : null));
    ipcMain.handle('desktop:settings', (event) => (fromApp(event) ? settings.get() : null));
    ipcMain.handle('desktop:update-settings', (event, changes) => {
        if (!fromApp(event)) return null;
        const before = settings.get();
        const next = settings.update(changes);
        if (next.startAtLogin !== before.startAtLogin) setStartAtLogin(app, next.startAtLogin);
        return { settings: next, failedShortcuts: applyDesktopShortcuts() };
    });
    ipcMain.on('desktop:notify', (event, notification) => { if (fromApp(event)) notifier.show(notification); });
    ipcMain.on('desktop:unread', (event, unread) => { if (fromApp(event)) tray.setUnread(win, unread); });
    ipcMain.handle('desktop:screen-sources', (event) => (fromApp(event) ? screenShare.listSources() : null));
    ipcMain.handle('desktop:choose-screen-source', (event, id, audio) =>
        (fromApp(event) && typeof id === 'string' ? screenShare.choose(id, audio === true) : false));
    ipcMain.handle('desktop:check-updates', (event) => (fromApp(event) ? updater.check() : null));
    ipcMain.on('desktop:install-update', (event) => {
        if (!fromApp(event) || !updater.isReady()) return;
        quitting = true;
        updater.install();
    });
}

function start() {
    settings = createSettingsStore(app.getPath('userData'));
    handleScheme(protocol, net, path.resolve(BUILD_DIR));
    screenShare = createScreenShare({
        desktopCapturer,
        platform: process.platform,
        origin: ORIGIN,
        ownSourceId: () => (win && !win.isDestroyed() ? win.getMediaSourceId() : null),
    });
    setUpPermissions();
    notifier = createNotifier({
        onClick(url) {
            showWindow();
            win?.webContents.send('desktop:navigate', url);
        },
    });
    tray = createTray({ showWindow, quit });
    updater = createUpdater({ app, onReady: (version) => win?.webContents.send('desktop:update-ready', version) });
    setUpIpc();
    // Keeps the login item current (e.g. after the AppImage moved).
    if (settings.get().startAtLogin) setStartAtLogin(app, true);

    createWindow(startedHidden(app));
    applyDesktopShortcuts();
    updater.start();

    app.on('activate', showWindow); // macOS: clicking the dock icon
    app.on('before-quit', () => {
        quitting = true;
        rememberBounds();
    });
    app.on('will-quit', () => globalShortcut.unregisterAll());
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') quit();
});
