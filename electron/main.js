// The desktop app: one window showing the client build that ships inside the app (see
// protocol.js), plus what a browser tab can't do: notifications without web push, a tray
// icon with the unread count, closing to the tray, starting at login, global mute/deafen
// shortcuts, push to talk in other apps, a screen picker for screen sharing, games' Rich Presence, the in-game overlay and updating itself. The page reaches these through preload.js.
// It starts with a splash window (splash.js) that installs any update before the app opens.
// The Steam Deck's Gaming Mode changes a few of these (gamingMode.js).
// (Its other windows are a popped-out screen share, which the page draws itself, windowOpen.js,
// and the in-game overlay, overlay.js.)
const path = require('path');
const { app, BrowserWindow, Menu, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, protocol, screen, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const nodeNet = require('net');
const { setUpSpellcheck, syncSpellingWords } = require('./spellcheck');
const { ORIGIN, isAppOrigin, registerScheme, handleScheme } = require('./protocol');
const { createSettingsStore } = require('./desktopSettings');
const { createTray } = require('./tray');
const { createNotifier, cleanNotification } = require('./notifications');
const { applyShortcuts } = require('./shortcuts');
const { createPushToTalk } = require('./pushToTalk');
const { createUpdater } = require('./updater');
const { createSplash } = require('./splash');
const { setStartAtLogin, startedHidden } = require('./autoStart');
const { createScreenShare } = require('./screenShare');
const { windowOpenAction, streamWindowPermission } = require('./windowOpen');
const { setUpYouTubeReferer } = require('./youtube');
const { fetchPage } = require('./pageFetch');
const { createFileSaver } = require('./fileSave');
const { createRichPresenceServer } = require('./richPresence');
const { createGameActivities, pictureFrom } = require('./gameActivities');
const { identifyGame, steamApps, steamPicture, steamRoots } = require('./gameLookup');
const { inGamingMode } = require('./gamingMode');
const { createOverlay, OVERLAY_PRELOAD } = require('./overlay');
const { runningSteamGames } = require('./runningGames');

const APP_ID = 'com.voicaw.app';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const BUILD_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '../build');
// Only the app's own pages get these (microphone, notifications, copying, full screen video,
// and screen capture, which only ever gets what the person picked in our picker).
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']);

registerScheme(protocol);

const gamingMode = inGamingMode();
// gamescope shows X11 apps (through its Xwayland); Electron would otherwise pick Wayland there.
if (gamingMode) app.commandLine.appendSwitch('ozone-platform', 'x11');

let win = null;
let splash = null; // while the app starts
// The popped-out screen share's window (windowOpen.js), while it's open.
const streamWindows = new WeakSet();
let quitting = false;
let settings;
let tray;
let notifier;
let updater;
let screenShare;
let fileSaver;
let richPresence;
let pushToTalk;
let gameActivities;
let overlay;
let lookForGames;

// One app at a time: starting it again brings the running one forward.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // notifications need it
    app.whenReady().then(start);
}

// The app's own page (not the overlay's, which shares its origin but only gets overlay.js's calls).
const fromApp = (event) => (event.senderFrame?.url ?? '').startsWith(`${ORIGIN}/`) && !overlay?.isOverlay(event.sender);

function showWindow() {
    if (!win) {
        splash?.window.focus();
        return;
    }
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

// `onShown`: once it's on screen (or would be, when hidden).
function createWindow(hidden, onShown = () => {}) {
    win = new BrowserWindow({
        icon: ICON,
        width: 1200,
        height: 800,
        minWidth: 480,
        minHeight: 400,
        ...savedBounds(),
        show: false,
        backgroundColor: '#18161e',
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

    win.once('ready-to-show', () => {
        if (!hidden) win.show();
        onShown();
    });
    // A page loading afresh (or gone) hasn't asked for push to talk (yet).
    win.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) pushToTalk.set(null);
    });
    win.webContents.on('render-process-gone', () => pushToTalk.set(null));
    // An update that finished downloading before the page was there to hear it (or before a reload).
    win.webContents.on('did-finish-load', () => {
        const version = updater.readyVersion();
        if (version && !gamingMode) win.webContents.send('desktop:update-ready', version);
    });

    // Links to other sites open in the browser; the window only ever shows the app, and the
    // windows it may open are a popped-out screen share and Watch Together (windowOpen.js).
    const icon = ICON;
    win.webContents.setWindowOpenHandler((details) => windowOpenAction(details, { icon, openExternal: (url) => shell.openExternal(url) }));
    win.webContents.on('did-create-window', (child) => {
        child.removeMenu();
        streamWindows.add(child.webContents);
        child.webContents.setWindowOpenHandler(({ url }) => windowOpenAction({ url }, { icon, openExternal: (link) => shell.openExternal(link) }));
        child.webContents.on('will-navigate', (event) => event.preventDefault());
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
    // Gaming Mode has no tray to come back from: closing there quits.
    win.on('close', (event) => {
        rememberBounds();
        if (!quitting && !gamingMode && (settings.get().closeToTray || process.platform === 'darwin')) {
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
        if (streamWindows.has(webContents)) return callback(streamWindowPermission(permission));
        const ours = (details.requestingUrl ?? '').startsWith(`${ORIGIN}/`);
        // 'media': the microphone and the camera (screen capture goes through the handler below).
        callback(ours && ALLOWED_PERMISSIONS.has(permission));
    });
    ses.setDisplayMediaRequestHandler((request, callback) => screenShare.handleRequest(request, callback));
    setUpYouTubeReferer(ses);
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
        (webContents && streamWindows.has(webContents)
            ? streamWindowPermission(permission)
            : isAppOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission)));
}

// Returns the actions whose key couldn't be registered. The overlay's is only held while
// it's up (other apps may use it the rest of the time), and only checked otherwise.
function applyDesktopShortcuts() {
    const onAction = (action) => {
        if (action === 'toggleOverlay') overlay.toggleLock();
        else win?.webContents.send('desktop:shortcut', action);
    };
    return applyShortcuts(settings.get().shortcuts, onAction, { checkOnly: overlay.isShown() ? [] : ['toggleOverlay'] });
}

// Runs a program, resolving to what it printed (for gameLookup.js: PowerShell, ps, reg).
function run(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
}

// Steam's install folder from the registry (Windows), looked up once.
let registrySteamPath;
async function windowsSteamPath() {
    if (registrySteamPath === undefined) {
        registrySteamPath = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'])
            .then((out) => /SteamPath\s+REG_SZ\s+(.+)/.exec(out)?.[1].trim().replace(/\//g, '\\') ?? null)
            .catch(() => null);
    }
    return registrySteamPath;
}

// Rich Presence (richPresence.js): games' activities, named and pictured from this computer
// (gameLookup.js), sent to the page, which shares them.
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

function setUpRichPresence() {
    gameActivities = createGameActivities({
        async identify(pid) {
            const platform = process.platform;
            const roots = steamRoots({ platform, home: os.homedir(), registrySteamPath: platform === 'win32' ? await windowsSteamPath() : null });
            return identifyGame(pid, { platform, fs, run, listSteamApps: () => steamApps(fs, roots) });
        },
        async loadPicture(game) {
            if (game.picture) return pictureFrom(nativeImage.createFromPath(game.picture), { photo: true });
            // Linux's file icons are only the theme's generic ones.
            if (game.exe && process.platform !== 'linux') return pictureFrom(await app.getFileIcon(game.exe, { size: 'large' }), { photo: false });
            return null;
        },
        // A picture the game gives as a web address (a music server's album cover): fetched
        // here, as anything on this computer could, then made small like the others.
        async fetchPicture(url) {
            const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
            if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? '')) return null;
            if (Number(response.headers.get('content-length')) > MAX_PICTURE_BYTES) return null;
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > MAX_PICTURE_BYTES) return null;
            return pictureFrom(nativeImage.createFromBuffer(bytes), { photo: true });
        },
        onChange: (activities) => {
            win?.webContents.send('desktop:activities', activities);
            overlay.setGames({ presence: activities.some(playing) });
        },
    });
    richPresence = createRichPresenceServer({ net: nodeNet, fs, onChange: (games) => gameActivities.update(games) });
    applyRichPresence();
    app.on('will-quit', () => richPresence.stop());
}

function applyRichPresence() {
    if (!settings.get().richPresence) {
        richPresence.stop();
        gameActivities.setSteamGames([]);
        overlay.setGames({ presence: false });
        return;
    }
    lookForGames?.();
    richPresence.start().then((file) => {
        if (!file) console.error('Rich Presence: every discord-ipc socket is taken');
    }).catch((err) => console.error('Rich Presence failed to start', err.message));
}

// For the overlay, a game is something played or competed in (not music or a video).
const playing = (activity) => activity.type === 0 || activity.type === 5;

// Steam's installed apps, listed again now and then (games get installed).
const STEAM_APPS_TTL_MS = 10 * 60 * 1000;
let steamAppsCache = null;
async function installedSteamApps() {
    if (!steamAppsCache || Date.now() - steamAppsCache.at > STEAM_APPS_TTL_MS) {
        const platform = process.platform;
        const roots = steamRoots({ platform, home: os.homedir(), registrySteamPath: platform === 'win32' ? await windowsSteamPath() : null });
        steamAppsCache = { at: Date.now(), apps: steamApps(fs, roots) };
    }
    return steamAppsCache.apps;
}

// The in-game overlay (overlay.js): shown while in voice and playing. Games that don't use
// Rich Presence are looked for among the running programs (runningGames.js), every 15
// seconds, while the overlay could be shown or Rich Presence is on (then they're shared as
// "Playing X" too, gameActivities.js).
const GAME_POLL_MS = 15 * 1000;

function setUpOverlay() {
    overlay = createOverlay({
        createWindow: (options) => new BrowserWindow({ icon: ICON, ...options }),
        screen,
        url: `${ORIGIN}/overlay.html`,
        preload: OVERLAY_PRELOAD,
        getSettings: () => settings.get(),
        disabled: gamingMode,
        onAction: (action) => win?.webContents.send('desktop:shortcut', action),
        onOpen(url) {
            showWindow();
            if (url) win?.webContents.send('desktop:navigate', url);
        },
        onPosition: (position) => {
            settings.update({ overlayPosition: position });
            overlay.settingsChanged();
        },
        onShownChange: () => applyDesktopShortcuts(),
    });
    let polling = false;
    async function look() {
        if (polling) return;
        const forOverlay = overlay.lookingForGames();
        const share = settings.get().richPresence;
        if (!forOverlay) overlay.setGames({ running: false });
        if (!share) gameActivities.setSteamGames([]);
        if (!forOverlay && !share) return;
        polling = true;
        try {
            const games = await runningSteamGames({ platform: process.platform, fs, run, apps: await installedSteamApps() });
            if (overlay.lookingForGames()) overlay.setGames({ running: games.length > 0 });
            if (settings.get().richPresence) {
                gameActivities.setSteamGames(games.map((game) => ({ appId: game.appId, name: game.name, picture: steamPicture(fs, game.root, game.appId) })));
            }
        } catch (err) {
            console.error('Looking for running games failed', err.message);
        } finally {
            polling = false;
        }
    }
    const timer = setInterval(look, GAME_POLL_MS);
    app.on('will-quit', () => clearInterval(timer));
    return look;
}

function setUpIpc() {
    ipcMain.handle('desktop:info', (event) => (fromApp(event) ? { version: app.getVersion(), packaged: app.isPackaged } : null));
    ipcMain.handle('desktop:settings', (event) => (fromApp(event) ? settings.get() : null));
    ipcMain.handle('desktop:update-settings', (event, changes) => {
        if (!fromApp(event)) return null;
        const before = settings.get();
        const next = settings.update(changes);
        if (next.startAtLogin !== before.startAtLogin) setStartAtLogin(app, next.startAtLogin);
        if (next.richPresence !== before.richPresence) applyRichPresence();
        if (next.overlay !== before.overlay || next.overlayPosition !== before.overlayPosition) {
            overlay.settingsChanged();
            if (next.overlay) lookForGames();
        }
        if (next.autoUpdate && !before.autoUpdate) updater.check();
        return { settings: next, failedShortcuts: applyDesktopShortcuts() };
    });
    ipcMain.handle('desktop:activities', (event) => (fromApp(event) ? gameActivities.current() : []));
    ipcMain.on('desktop:notify', (event, notification) => {
        if (!fromApp(event)) return;
        // Over a game, the overlay shows it instead.
        if (!overlay.toast(cleanNotification(notification))) notifier.show(notification);
    });
    ipcMain.on('desktop:close-notification', (event, tag) => { if (fromApp(event)) notifier.close(tag); });
    // The voice state the overlay shows (null: not in voice), whenever it changes.
    ipcMain.on('desktop:overlay-voice', (event, state) => {
        if (!fromApp(event)) return;
        const wasInVoice = overlay.lookingForGames();
        overlay.setVoice(state);
        if (!wasInVoice && overlay.lookingForGames()) lookForGames();
    });
    // Push to talk in other apps (pushToTalk.js): the key to listen for while in voice, or null.
    // Resolves whether it's listening.
    ipcMain.handle('desktop:push-to-talk', (event, key) => (fromApp(event) ? pushToTalk.set(typeof key === 'string' ? key : null) : false));
    ipcMain.on('overlay:message', (event, message) => {
        if (overlay.isOverlay(event.sender)) overlay.handle(message);
    });
    ipcMain.on('desktop:unread', (event, unread) => { if (fromApp(event)) tray.setUnread(win, unread); });
    ipcMain.handle('desktop:screen-sources', (event) => (fromApp(event) ? screenShare.listSources() : null));
    ipcMain.handle('desktop:choose-screen-source', (event, id, audio) =>
        (fromApp(event) && typeof id === 'string' ? screenShare.choose(id, audio === true) : false));
    // The page's own right-click menu (client PageMenus): a real paste, and its dictionary.
    ipcMain.on('desktop:paste', (event) => { if (fromApp(event)) event.sender.paste(); });
    ipcMain.on('desktop:spelling-words', (event, words) => {
        if (fromApp(event)) syncSpellingWords(event.sender.session, words).catch(() => {});
    });
    // A linked page for a link preview in an encrypted chat (pageFetch.js).
    ipcMain.handle('desktop:fetch-page', (event, url) => (fromApp(event) ? fetchPage(url) : null));
    // Saving a big attachment a piece at a time (fileSave.js).
    ipcMain.handle('desktop:save-start', (event, name) => (fromApp(event) ? fileSaver.start(name) : null));
    ipcMain.handle('desktop:save-append', (event, id, bytes) => {
        if (!fromApp(event) || !(bytes instanceof Uint8Array)) throw new Error('Not allowed');
        return fileSaver.append(id, bytes);
    });
    ipcMain.handle('desktop:save-finish', async (event, id) => {
        if (fromApp(event)) await fileSaver.finish(id);
    });
    ipcMain.handle('desktop:save-cancel', (event, id) => (fromApp(event) ? fileSaver.cancel(id) : null));
    ipcMain.handle('desktop:check-updates', (event) => (fromApp(event) ? updater.check() : null));
    // Resolves to false if there was nothing to install; otherwise the app restarts onto it.
    ipcMain.handle('desktop:install-update', (event) => {
        if (!fromApp(event)) return false;
        return updater.install(() => { quitting = true; });
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
    fileSaver = createFileSaver({
        showSaveDialog: (options) => (win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)),
        fs,
        downloadsDir: () => app.getPath('downloads'),
    });
    notifier = createNotifier({
        onClick(url) {
            showWindow();
            win?.webContents.send('desktop:navigate', url);
        },
    });
    tray = createTray({ showWindow, quit });
    updater = createUpdater({
        app,
        gamingMode,
        autoUpdate: () => settings.get().autoUpdate,
        onReady: (version) => win?.webContents.send('desktop:update-ready', version),
        onProgress: (fraction) => {
            splash?.progress(fraction);
            win?.webContents.send('desktop:update-progress', fraction);
        },
    });
    lookForGames = setUpOverlay();
    pushToTalk = createPushToTalk({ onChange: (down) => win?.webContents.send('desktop:push-to-talk', down) });
    setUpIpc();
    setUpRichPresence();
    // Keeps the login item current (e.g. after the AppImage moved).
    if (settings.get().startAtLogin) setStartAtLogin(app, true);

    if (startedHidden(app)) {
        openApp(true);
        updater.start();
    } else if (gamingMode) {
        // No splash: its update restarts the app, and Steam would think the game had closed.
        openApp(false);
        updater.start();
    } else {
        startWithSplash();
    }

    app.on('activate', showWindow); // macOS: clicking the dock icon
    app.on('before-quit', () => {
        quitting = true;
        rememberBounds();
    });
    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        pushToTalk.stop();
    });
}

function openApp(hidden, onShown) {
    createWindow(hidden, onShown);
    applyDesktopShortcuts();
}

// The splash looks for an update and installs it (the app restarts onto it), or opens the app,
// staying up until the main window is on screen. Closing it quits.
function startWithSplash() {
    let launch = null;
    splash = createSplash({ icon: ICON, onStartAnyway: () => launch?.startAnyway() });
    splash.window.on('closed', () => { splash = null; });
    launch = updater.launch({
        onStatus: (status) => splash?.status(status),
        beforeQuit: () => { quitting = true; },
    });
    launch.result.then((outcome) => {
        if (outcome === 'installing' || quitting) return;
        splash?.status(null); // starting
        openApp(false, () => splash?.close());
        updater.start({ lookNow: false });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') quit();
});
