// The in-game overlay (as Discord's): while you're in a voice channel or call and playing a
// game, a small window over the game shows who's there and who's talking, and the app's
// notifications as toasts. It's a transparent, frameless, always-on-top window the mouse goes
// through ("locked"), on the game's screen (gameWindow.js; the pointer's when the game's window
// can't be found), in the corner chosen.
// Its shortcut (Settings → Desktop App, default Ctrl+Shift+O; only taken while it's up)
// unlocks it: it then covers the screen, dims the game and takes the mouse and keyboard, with
// mute, deafen, disconnect, the corner and Open Voicaw; the shortcut again, Escape or a click
// on the dimmed part locks it again.
// It draws over borderless and windowed games; a game in exclusive full screen (Windows) or
// a Wayland session's own windows can keep it out, which Discord only gets past by injecting
// into games (not done). Never in the Steam Deck's Gaming Mode (gamescope shows one app).
// Its page is the client's overlay.html (client/src/overlay/), with only overlayPreload.js:
// it never sees the account, keys or messages, only what the main page sends for it (the
// voice state, notifications' text and pictures), passed on from here.
const path = require('path');

// Its locked size is what the page says its content needs, kept within these.
const MAX_LOCKED = { width: 360, height: 720 };
const MARGIN = 16;
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
// How often a game's window that wasn't found is looked for again.
const RETRY_MS = 10 * 1000;

// Where the locked window goes: `area` the screen's bounds, `size` the content's.
function lockedBounds(area, size, position) {
    const width = Math.min(Math.max(Math.round(size?.width) || 0, 1), MAX_LOCKED.width, area.width);
    const height = Math.min(Math.max(Math.round(size?.height) || 0, 1), MAX_LOCKED.height, area.height);
    const right = position.endsWith('right');
    const bottom = position.startsWith('bottom');
    return {
        x: right ? area.x + area.width - width - MARGIN : area.x + MARGIN,
        y: bottom ? area.y + area.height - height - MARGIN : area.y + MARGIN,
        width,
        height,
    };
}

const text = (value, max) => (typeof value === 'string' ? [...value].slice(0, max).join('') : '');

// The voice state from the main page (client utils/overlay.js `overlayVoiceState`), checked:
// it's page input passed on to another page. null: not in voice.
function cleanVoiceState(input) {
    if (!input || typeof input !== 'object') return null;
    const members = Array.isArray(input.members) ? input.members.slice(0, 99) : [];
    return {
        title: text(input.title, 200),
        status: ['connecting', 'connected', 'reconnecting'].includes(input.status) ? input.status : 'connected',
        selfMute: input.selfMute === true,
        selfDeaf: input.selfDeaf === true,
        members: members.filter((m) => m && typeof m === 'object').map((m) => ({
            id: text(String(m.id ?? ''), 40),
            name: text(m.name, 100),
            avatar: typeof m.avatar === 'string' && /^(https?:|voicaw:|\/)/.test(m.avatar) ? m.avatar.slice(0, 2000) : null,
            speaking: m.speaking === true,
            muted: m.muted === true,
            deafened: m.deafened === true,
            self: m.self === true,
        })),
    };
}

// `createWindow(options)`: Electron's BrowserWindow. `screen`: Electron's. `url`: the page.
// `getSettings()`: the desktop settings. `onAction(action)`: the overlay's buttons
// ('toggleMute', 'toggleDeafen', 'disconnect'), for the main page. `onOpen(url)`: Open Voicaw,
// or a toast clicked (its chat). `onPosition(corner)`: a corner picked on it, to save.
// `onShownChange(shown)`: it appeared or went (main.js takes or
// frees the shortcut). `findGameScreen(pids)`: resolves to a point on the screen the game's
// window is on (Electron's coordinates), or null.
function createOverlay({ createWindow, screen, url, preload, getSettings, onAction, onOpen, onPosition, onShownChange = () => {}, findGameScreen = null, disabled = false }) {
    let voice = null;
    // `presencePids`: Rich Presence games' processes; `runningPids`: running Steam games'.
    let games = { presence: false, running: false, presencePids: [], runningPids: [] };
    let win = null;
    let shown = false;
    let unlocked = false;
    let contentSize = { width: 240, height: 120 };
    let display = null;
    let located = null; // the processes the game's screen was found for
    let lookup = 0; // the latest lookup's number (an older one's answer is dropped)
    let tried = { key: null, at: 0 }; // the last lookup started (retried after RETRY_MS)

    const position = () => (POSITIONS.includes(getSettings().overlayPosition) ? getSettings().overlayPosition : 'top-left');
    const wanted = () => !disabled && getSettings().overlay !== false && voice !== null && (games.presence || games.running);

    function view() {
        return {
            voice,
            unlocked,
            position: position(),
            shortcut: getSettings().shortcuts?.toggleOverlay ?? null,
        };
    }

    function place() {
        if (!win || win.isDestroyed() || !display) return;
        win.setBounds(unlocked ? display.bounds : lockedBounds(display.bounds, contentSize, position()));
    }

    const gamePids = () => [...new Set([...games.presencePids, ...games.runningPids])].sort((a, b) => a - b);

    // Moves it onto the game's screen. Asked when it appears, when it's unlocked, when the game's
    // processes change, and every RETRY_MS until the window is found (a game can be running a
    // while before it opens one); otherwise it stays where it is. Voice changes call this often
    // (who's talking), and a lookup can cost a PowerShell, so not every time.
    async function locate({ again = false } = {}) {
        if (!findGameScreen || !win || win.isDestroyed()) return;
        const pids = gamePids();
        const key = pids.join(',');
        if (!pids.length || (!again && located === key)) return;
        if (!again && tried.key === key && Date.now() - tried.at < RETRY_MS) return;
        tried = { key, at: Date.now() };
        const number = ++lookup;
        const target = win;
        const point = await Promise.resolve(findGameScreen(pids)).catch(() => null);
        if (number !== lookup || win !== target || !win || win.isDestroyed()) return;
        if (!point) {
            located = null;
            return;
        }
        located = key;
        display = screen.getDisplayNearestPoint(point);
        place();
    }

    function send(channel, value) {
        if (win && !win.isDestroyed()) win.webContents.send(channel, value);
    }

    function open() {
        // The pointer's screen until the game's is found (usually a moment later).
        display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        located = null;
        tried = { key: null, at: 0 };
        win = createWindow({
            ...lockedBounds(display.bounds, contentSize, position()),
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            focusable: false,
            alwaysOnTop: true,
            title: 'Voicaw overlay',
            webPreferences: {
                preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,
            },
        });
        // Above full-screen windows too (the 'screen-saver' level; macOS: on every Space).
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
        win.setIgnoreMouseEvents(true, { forward: true });
        win.removeMenu?.();
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event) => event.preventDefault());
        win.webContents.on('did-finish-load', () => send('overlay:state', view()));
        win.once('ready-to-show', () => {
            if (win && !win.isDestroyed()) win.showInactive();
        });
        win.on('closed', () => {
            win = null;
        });
        win.loadURL(url);
        locate();
    }

    function setUnlocked(on) {
        if (!win || win.isDestroyed() || unlocked === on) return;
        unlocked = on;
        win.setIgnoreMouseEvents(!on, { forward: true });
        win.setFocusable(on);
        place();
        if (on) locate({ again: true });
        if (on) win.focus();
        else win.blur();
        send('overlay:state', view());
    }

    // Shows or removes it as voice, games and settings say.
    function refresh() {
        const should = wanted();
        if (should && !shown) {
            shown = true;
            open();
            onShownChange(true);
        } else if (!should && shown) {
            shown = false;
            unlocked = false;
            if (win && !win.isDestroyed()) win.destroy();
            win = null;
            onShownChange(false);
        } else if (shown) {
            place();
            send('overlay:state', view());
            locate();
        }
    }

    return {
        setVoice(state) {
            voice = cleanVoiceState(state);
            refresh();
        },
        // `presence`: a Rich Presence game is playing; `running`: a Steam game is running;
        // `presencePids` / `runningPids`: their processes (for finding the game's screen).
        setGames(changes) {
            const pids = (list) => (Array.isArray(list) ? list.filter((p) => Number.isInteger(p) && p > 0).slice(0, 64) : []);
            games = {
                ...games,
                ...changes,
                presencePids: 'presencePids' in changes ? pids(changes.presencePids) : games.presencePids,
                runningPids: 'runningPids' in changes ? pids(changes.runningPids) : games.runningPids,
            };
            refresh();
        },
        settingsChanged: refresh,
        // Whether running games are worth looking for (main.js polls only then).
        lookingForGames: () => !disabled && getSettings().overlay !== false && voice !== null,
        isShown: () => shown,
        toggleLock: () => setUnlocked(!unlocked),
        // A notification (notifications.js `cleanNotification`), shown as a toast instead of the
        // system's while the overlay is up. Returns whether it was.
        toast(notification) {
            if (!shown || !notification) return false;
            send('overlay:toast', notification);
            return true;
        },
        // From the overlay's page.
        handle(message) {
            if (!shown || !message || typeof message !== 'object') return;
            switch (message.type) {
                case 'size':
                    if (Number.isFinite(message.width) && Number.isFinite(message.height)) {
                        contentSize = { width: message.width, height: message.height };
                        if (!unlocked) place();
                    }
                    break;
                case 'position':
                    if (POSITIONS.includes(message.position)) onPosition(message.position);
                    break;
                case 'lock':
                    setUnlocked(false);
                    break;
                case 'toggleMute':
                case 'toggleDeafen':
                case 'disconnect':
                    onAction(message.type);
                    break;
                case 'open':
                    setUnlocked(false);
                    onOpen(typeof message.url === 'string' && message.url.startsWith('/') && !message.url.startsWith('//') ? message.url : null);
                    break;
                default:
                    break;
            }
        },
        // Whether `webContents` is the overlay's page.
        isOverlay: (webContents) => Boolean(win && !win.isDestroyed() && webContents === win.webContents),
    };
}

module.exports = { createOverlay, lockedBounds, cleanVoiceState, OVERLAY_PRELOAD: path.join(__dirname, 'overlayPreload.js') };
