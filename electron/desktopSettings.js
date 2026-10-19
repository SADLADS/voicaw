// The desktop app's own settings (Settings → Desktop App in the page), kept as JSON in the
// app's data folder: things the page can't do itself.
const fs = require('fs');
const path = require('path');

// A build made with VOICAW_AUTO_UPDATE=off (builder.config.js writes it into the packaged
// package.json) starts with automatic updates off, so it never asks the update site, not even
// at its first launch.
const AUTO_UPDATE_DEFAULT = require('./package.json').voicawAutoUpdate !== false;

const DEFAULTS = {
    // Closing the window leaves the app running in the tray (so notifications keep coming).
    closeToTray: true,
    // Start at login (autoStart.js), on by default as Discord's. startAtLoginChosen is set once
    // the person ticks or unticks it: saved files from before the default changed (which wrote
    // `false` without anyone choosing it) get the default instead.
    startAtLogin: true,
    startAtLoginChosen: false,
    // Rich Presence (richPresence.js): games' "Playing X" shared with everyone. Off: not even
    // listening for games.
    richPresence: true,
    // Updates (updater.js): looking for, downloading and installing new versions by itself. Off:
    // only Settings → App Version's "Check for updates" looks.
    autoUpdate: AUTO_UPDATE_DEFAULT,
    // The in-game overlay (overlay.js): who's talking in your voice channel or call, over the
    // game you're playing. Off: never shown, and running games aren't looked for.
    overlay: true,
    // Its corner of the screen.
    overlayPosition: 'top-left',
    // Global keyboard shortcuts (Electron accelerators, e.g. "CommandOrControl+Shift+M"), or null.
    // toggleOverlay (unlocking the overlay to click it) is only taken while the overlay is up.
    shortcuts: { toggleMute: null, toggleDeafen: null, toggleOverlay: 'CommandOrControl+Shift+O' },
    // Where the window was, restored on the next start.
    window: null,
};

// Only these can be changed from the page.
const SHORTCUT_ACTIONS = Object.keys(DEFAULTS.shortcuts);
const ACCELERATOR = /^[A-Za-z0-9+ ]{1,60}$/;
const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

function cleanChanges(changes) {
    const clean = {};
    if (typeof changes?.closeToTray === 'boolean') clean.closeToTray = changes.closeToTray;
    if (typeof changes?.startAtLogin === 'boolean') clean.startAtLogin = changes.startAtLogin;
    if (typeof changes?.richPresence === 'boolean') clean.richPresence = changes.richPresence;
    if (typeof changes?.autoUpdate === 'boolean') clean.autoUpdate = changes.autoUpdate;
    if (typeof changes?.overlay === 'boolean') clean.overlay = changes.overlay;
    if (OVERLAY_POSITIONS.includes(changes?.overlayPosition)) clean.overlayPosition = changes.overlayPosition;
    if (changes?.shortcuts && typeof changes.shortcuts === 'object') {
        clean.shortcuts = {};
        for (const action of SHORTCUT_ACTIONS) {
            const value = changes.shortcuts[action];
            if (value === null || (typeof value === 'string' && ACCELERATOR.test(value))) clean.shortcuts[action] = value;
        }
    }
    return clean;
}

function createSettingsStore(dir) {
    const file = path.join(dir, 'desktop-settings.json');
    let settings;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        settings = { ...DEFAULTS, ...saved, shortcuts: { ...DEFAULTS.shortcuts, ...saved.shortcuts } };
        if (!settings.startAtLoginChosen) settings.startAtLogin = DEFAULTS.startAtLogin;
    } catch {
        settings = { ...DEFAULTS, shortcuts: { ...DEFAULTS.shortcuts } };
    }

    function save() {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(settings, null, 2));
        } catch (err) {
            console.error('Could not save desktop settings', err.message);
        }
    }

    return {
        get: () => settings,
        // Changes from the page (checked); returns the new settings.
        update(changes) {
            const clean = cleanChanges(changes);
            settings = { ...settings, ...clean, shortcuts: { ...settings.shortcuts, ...clean.shortcuts } };
            if ('startAtLogin' in clean) settings.startAtLoginChosen = true;
            save();
            return settings;
        },
        setWindow(bounds) {
            settings = { ...settings, window: bounds };
            save();
        },
    };
}

module.exports = { createSettingsStore, cleanChanges, DEFAULTS, SHORTCUT_ACTIONS, OVERLAY_POSITIONS };
