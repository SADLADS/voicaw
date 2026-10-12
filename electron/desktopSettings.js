// The desktop app's own settings (Settings → Desktop App in the page), kept as JSON in the
// app's data folder: things the page can't do itself.
const fs = require('fs');
const path = require('path');

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
    // Global keyboard shortcuts (Electron accelerators, e.g. "CommandOrControl+Shift+M"), or null.
    shortcuts: { toggleMute: null, toggleDeafen: null },
    // Where the window was, restored on the next start.
    window: null,
};

// Only these can be changed from the page.
const SHORTCUT_ACTIONS = Object.keys(DEFAULTS.shortcuts);
const ACCELERATOR = /^[A-Za-z0-9+ ]{1,60}$/;

function cleanChanges(changes) {
    const clean = {};
    if (typeof changes?.closeToTray === 'boolean') clean.closeToTray = changes.closeToTray;
    if (typeof changes?.startAtLogin === 'boolean') clean.startAtLogin = changes.startAtLogin;
    if (typeof changes?.richPresence === 'boolean') clean.richPresence = changes.richPresence;
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

module.exports = { createSettingsStore, cleanChanges, DEFAULTS, SHORTCUT_ACTIONS };
