import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createOverlay, lockedBounds, cleanVoiceState } = require('../overlay.js');
const { runningSteamGame } = require('../runningGames.js');
const { createSettingsStore, cleanChanges } = require('../desktopSettings.js');

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

// A stand-in BrowserWindow: records what was asked of it.
function fakeWindow(options) {
    const handlers = {};
    const win = {
        options,
        bounds: { x: options.x, y: options.y, width: options.width, height: options.height },
        ignoreMouse: null,
        focusable: options.focusable,
        destroyed: false,
        shown: false,
        sent: [],
        loaded: null,
        setAlwaysOnTop: vi.fn(),
        setVisibleOnAllWorkspaces: vi.fn(),
        setIgnoreMouseEvents(on) { win.ignoreMouse = on; },
        setFocusable(on) { win.focusable = on; },
        setBounds(bounds) { win.bounds = bounds; },
        focus: vi.fn(),
        blur: vi.fn(),
        removeMenu: vi.fn(),
        isDestroyed: () => win.destroyed,
        destroy() { win.destroyed = true; handlers.closed?.(); },
        showInactive() { win.shown = true; },
        on(event, handler) { handlers[event] = handler; },
        once(event, handler) { handlers[event] = handler; },
        loadURL(url) { win.loaded = url; },
        emit: (event) => handlers[event]?.(),
        webContents: {
            send: (channel, value) => win.sent.push([channel, value]),
            setWindowOpenHandler: vi.fn(),
            on: vi.fn(),
        },
    };
    return win;
}

const VOICE = {
    title: 'General / Our guild',
    status: 'connected',
    selfMute: false,
    selfDeaf: false,
    members: [{ id: '1', name: 'Alice', avatar: null, speaking: true, muted: false, deafened: false, self: true }],
};

describe('the in-game overlay (overlay.js)', () => {
    let settings;
    let windows;
    let overlay;
    let calls;

    beforeEach(() => {
        settings = { overlay: true, overlayPosition: 'top-left', shortcuts: { toggleOverlay: 'CommandOrControl+Shift+O' } };
        windows = [];
        calls = { actions: [], opened: [], positions: [], shown: [] };
        overlay = createOverlay({
            createWindow: (options) => {
                const win = fakeWindow(options);
                windows.push(win);
                return win;
            },
            screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => ({ bounds: SCREEN }) },
            url: 'voicaw://app/overlay.html',
            preload: '/preload.js',
            getSettings: () => settings,
            onAction: (action) => calls.actions.push(action),
            onOpen: (url) => calls.opened.push(url),
            onPosition: (position) => calls.positions.push(position),
            onShownChange: (shown) => calls.shown.push(shown),
        });
    });

    it('shows only while in voice and playing, and goes when either stops', () => {
        overlay.setVoice(VOICE);
        expect(windows).toHaveLength(0);
        expect(overlay.lookingForGames()).toBe(true);
        overlay.setGames({ running: true });
        expect(windows).toHaveLength(1);
        expect(overlay.isShown()).toBe(true);
        const [win] = windows;
        expect(win.loaded).toBe('voicaw://app/overlay.html');
        // Click-through, never focused, above full-screen windows, out of the taskbar.
        expect(win.options).toMatchObject({ transparent: true, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true });
        expect(win.ignoreMouse).toBe(true);
        expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
        win.emit('ready-to-show');
        expect(win.shown).toBe(true);

        overlay.setGames({ running: false });
        expect(win.destroyed).toBe(true);
        expect(overlay.isShown()).toBe(false);
        overlay.setGames({ presence: true });
        expect(windows).toHaveLength(2);
        overlay.setVoice(null);
        expect(windows[1].destroyed).toBe(true);
        expect(calls.shown).toEqual([true, false, true, false]);
    });

    it('never shows with the setting off, or when disabled (Gaming Mode)', () => {
        settings.overlay = false;
        overlay.setVoice(VOICE);
        overlay.setGames({ running: true });
        expect(windows).toHaveLength(0);
        expect(overlay.lookingForGames()).toBe(false);
        settings.overlay = true;
        overlay.settingsChanged();
        expect(windows).toHaveLength(1);
        settings.overlay = false;
        overlay.settingsChanged();
        expect(windows[0].destroyed).toBe(true);

        const gaming = createOverlay({
            createWindow: () => { throw new Error('no window'); },
            screen: {},
            getSettings: () => ({ overlay: true }),
            disabled: true,
        });
        gaming.setVoice(VOICE);
        gaming.setGames({ running: true });
        expect(gaming.isShown()).toBe(false);
        expect(gaming.lookingForGames()).toBe(false);
    });

    it('sits in its corner at the size of its content, and covers the screen unlocked', () => {
        overlay.setVoice(VOICE);
        overlay.setGames({ running: true });
        const [win] = windows;
        overlay.handle({ type: 'size', width: 280, height: 90 });
        expect(win.bounds).toEqual({ x: 16, y: 16, width: 280, height: 90 });

        overlay.toggleLock();
        expect(win.bounds).toEqual(SCREEN);
        expect(win.ignoreMouse).toBe(false);
        expect(win.focusable).toBe(true);
        expect(win.focus).toHaveBeenCalled();
        expect(win.sent.at(-1)).toEqual(['overlay:state', expect.objectContaining({ unlocked: true, position: 'top-left', shortcut: 'CommandOrControl+Shift+O' })]);
        // Its size while unlocked (the bigger panel) doesn't move it.
        overlay.handle({ type: 'size', width: 280, height: 300 });
        expect(win.bounds).toEqual(SCREEN);

        overlay.handle({ type: 'lock' });
        expect(win.ignoreMouse).toBe(true);
        expect(win.focusable).toBe(false);
        expect(win.blur).toHaveBeenCalled();
        settings.overlayPosition = 'bottom-right';
        overlay.handle({ type: 'size', width: 280, height: 90 });
        expect(win.bounds).toEqual({ x: 1920 - 280 - 16, y: 1080 - 90 - 16, width: 280, height: 90 });
    });

    it("passes on the page's buttons, and nothing it shouldn't", () => {
        overlay.setVoice(VOICE);
        overlay.setGames({ running: true });
        overlay.handle({ type: 'toggleMute' });
        overlay.handle({ type: 'toggleDeafen' });
        overlay.handle({ type: 'disconnect' });
        overlay.handle({ type: 'quit' });
        expect(calls.actions).toEqual(['toggleMute', 'toggleDeafen', 'disconnect']);
        overlay.handle({ type: 'position', position: 'top-right' });
        overlay.handle({ type: 'position', position: 'middle' });
        expect(calls.positions).toEqual(['top-right']);
        overlay.handle({ type: 'open', url: '/dm/2' });
        overlay.handle({ type: 'open', url: 'https://evil.example/' });
        overlay.handle({ type: 'open', url: '//evil.example/' });
        expect(calls.opened).toEqual(['/dm/2', null, null]);
    });

    it('takes notifications as toasts only while shown', () => {
        expect(overlay.toast({ title: 'Alice', body: 'hi', url: '/dm/1' })).toBe(false);
        overlay.setVoice(VOICE);
        overlay.setGames({ running: true });
        expect(overlay.toast({ title: 'Alice', body: 'hi', url: '/dm/1' })).toBe(true);
        expect(windows[0].sent.at(-1)).toEqual(['overlay:toast', { title: 'Alice', body: 'hi', url: '/dm/1' }]);
    });

    it('keeps the locked window within limits and on the screen', () => {
        expect(lockedBounds(SCREEN, { width: 5000, height: 5000 }, 'top-left')).toEqual({ x: 16, y: 16, width: 360, height: 720 });
        expect(lockedBounds({ x: 1920, y: 0, width: 1280, height: 720 }, { width: 200, height: 100 }, 'top-right'))
            .toEqual({ x: 1920 + 1280 - 200 - 16, y: 16, width: 200, height: 100 });
        expect(lockedBounds(SCREEN, { width: NaN, height: -3 }, 'top-left')).toEqual({ x: 16, y: 16, width: 1, height: 1 });
    });

    it("checks the page's voice state", () => {
        expect(cleanVoiceState(null)).toBeNull();
        const clean = cleanVoiceState({
            title: 'x'.repeat(500),
            status: 'evil',
            selfMute: 'yes',
            members: [
                { id: 3, name: 'Bob', avatar: 'javascript:alert(1)', speaking: true, extra: 1 },
                { id: '4', name: 'Carol', avatar: 'https://s3.example/profile-pics/4/a.webp' },
                null,
            ],
        });
        expect(clean.title).toHaveLength(200);
        expect(clean.status).toBe('connected');
        expect(clean.selfMute).toBe(false);
        expect(clean.members).toEqual([
            { id: '3', name: 'Bob', avatar: null, speaking: true, muted: false, deafened: false, self: false },
            { id: '4', name: 'Carol', avatar: 'https://s3.example/profile-pics/4/a.webp', speaking: false, muted: false, deafened: false, self: false },
        ]);
    });
});

describe('running Steam games (runningGames.js)', () => {
    const apps = [
        { appId: '252490', name: 'Rust', installDir: 'Rust', library: '/games', root: '/steam' },
        { appId: '1493710', name: 'Proton Experimental', installDir: 'Proton - Experimental', library: '/games', root: '/steam' },
    ];

    // A stand-in /proc: { pid: { environ, cmdline } } (a pid without environ isn't readable).
    function fakeProc(processes) {
        return {
            readdirSync: (dir) => (dir === '/proc' ? [...Object.keys(processes), 'self', 'net'] : []),
            readFileSync(file) {
                const [, pid, name] = /^\/proc\/(\d+)\/(\w+)$/.exec(file) ?? [];
                const value = processes[pid]?.[name];
                if (value === undefined) throw new Error('EACCES');
                return value;
            },
        };
    }

    it("finds a Linux game by Steam's app id or its folder, never Proton itself", async () => {
        const run = vi.fn();
        expect(await runningSteamGame({ platform: 'linux', fs: fakeProc({ 1: { environ: 'HOME=/x\0', cmdline: '/usr/bin/bash\0' } }), run, apps })).toBeNull();
        expect(await runningSteamGame({ platform: 'linux', fs: fakeProc({ 7: { environ: 'SteamAppId=252490\0', cmdline: 'game\0' } }), run, apps }))
            .toEqual({ appId: '252490', name: 'Rust' });
        // Proton's own process, with the game's path among its arguments.
        const proton = { environ: 'SteamAppId=1493710\0', cmdline: '/games/steamapps/common/Proton - Experimental/proton\0waitforexitandrun\0Z:\\games\\steamapps\\common\\Rust\\RustClient.exe\0' };
        expect(await runningSteamGame({ platform: 'linux', fs: fakeProc({ 9: proton }), run, apps })).toEqual({ appId: '252490', name: 'Rust' });
        // Steam's app id 0, and someone else's process: not games.
        expect(await runningSteamGame({ platform: 'linux', fs: fakeProc({ 5: { environ: 'SteamAppId=0\0', cmdline: 'steam\0' }, 6: { cmdline: '/games/steamapps/common/Rust/RustClient\0' } }), run, apps })).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it("finds a Windows game from WMI's paths, and copes with nothing found or a failure", async () => {
        const fs = {};
        let out = JSON.stringify('C:\\Games\\steamapps\\common\\Rust\\RustClient.exe');
        const run = vi.fn(async () => out);
        expect(await runningSteamGame({ platform: 'win32', fs, run, apps })).toEqual({ appId: '252490', name: 'Rust' });
        expect(run.mock.calls[0][0]).toBe('powershell.exe');
        out = JSON.stringify(['C:\\Games\\steamapps\\common\\Proton - Experimental\\x.exe', 'C:\\Games\\steamapps\\common\\Rust\\RustClient.exe']);
        expect(await runningSteamGame({ platform: 'win32', fs, run, apps })).toEqual({ appId: '252490', name: 'Rust' });
        out = '';
        expect(await runningSteamGame({ platform: 'win32', fs, run, apps })).toBeNull();
        run.mockRejectedValueOnce(new Error('no PowerShell'));
        expect(await runningSteamGame({ platform: 'win32', fs, run, apps })).toBeNull();
        expect(await runningSteamGame({ platform: 'win32', fs, run, apps: [] })).toBeNull();
    });

    it('finds a macOS game from ps', async () => {
        const run = vi.fn(async () => '/sbin/launchd\n/Users/a/Library/Application Support/Steam/steamapps/common/Rust/Rust.app/Contents/MacOS/Rust\n');
        expect(await runningSteamGame({ platform: 'darwin', fs: {}, run, apps })).toEqual({ appId: '252490', name: 'Rust' });
    });
});

describe('overlay settings (desktopSettings.js)', () => {
    it('is on by default, top left, with its own shortcut, also for settings saved before it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-settings-'));
        fs.writeFileSync(path.join(dir, 'desktop-settings.json'), JSON.stringify({ shortcuts: { toggleMute: 'Control+M' } }));
        expect(createSettingsStore(dir).get()).toMatchObject({
            overlay: true,
            overlayPosition: 'top-left',
            shortcuts: { toggleMute: 'Control+M', toggleOverlay: 'CommandOrControl+Shift+O' },
        });
        const store = createSettingsStore(dir);
        store.update({ overlay: false, overlayPosition: 'bottom-right', shortcuts: { toggleOverlay: 'Alt+F9' } });
        expect(createSettingsStore(dir).get()).toMatchObject({ overlay: false, overlayPosition: 'bottom-right', shortcuts: { toggleOverlay: 'Alt+F9' } });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('takes only real values', () => {
        expect(cleanChanges({ overlay: 'no', overlayPosition: 'middle' })).toEqual({});
        expect(cleanChanges({ overlay: false, overlayPosition: 'top-right', shortcuts: { toggleOverlay: null } }))
            .toEqual({ overlay: false, overlayPosition: 'top-right', shortcuts: { toggleOverlay: null } });
    });
});
