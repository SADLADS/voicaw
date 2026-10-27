// Global keyboard shortcuts (they work while another app has focus): toggle mute, toggle
// deafen and unlocking the in-game overlay (overlay.js), set in Settings → Desktop App. Electron only reports key presses, never releases,
// so push to talk (held down) uses a keyboard hook instead (pushToTalk.js).
const { globalShortcut } = require('electron');

// Registers `shortcuts` ({ action: accelerator | null }), replacing whatever was registered.
// `onAction(action)` runs on a press. Actions in `checkOnly` aren't kept (a key only needed
// sometimes, which other apps can have the rest of the time): only taken and given back, to
// see whether they could be. Returns the actions whose key couldn't be taken (in use by
// another app, or not a valid accelerator).
function applyShortcuts(shortcuts, onAction, { checkOnly = [] } = {}) {
    globalShortcut.unregisterAll();
    const failed = [];
    for (const [action, accelerator] of Object.entries(shortcuts)) {
        if (!accelerator) continue;
        let ok = false;
        try {
            ok = globalShortcut.register(accelerator, () => onAction(action));
            if (ok && checkOnly.includes(action)) globalShortcut.unregister(accelerator);
        } catch {
            ok = false;
        }
        if (!ok) failed.push(action);
    }
    return failed;
}

module.exports = { applyShortcuts };
