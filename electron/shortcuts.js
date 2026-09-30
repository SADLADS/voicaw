// Global keyboard shortcuts (they work while another app has focus): toggle mute and toggle
// deafen, set in Settings → Desktop App. Electron only reports key presses, never releases,
// so push-to-talk (held down) would need a native keyboard hook; not done.
const { globalShortcut } = require('electron');

// Registers `shortcuts` ({ action: accelerator | null }), replacing whatever was registered.
// `onAction(action)` runs on a press. Returns the actions whose key couldn't be taken (in use
// by another app, or not a valid accelerator).
function applyShortcuts(shortcuts, onAction) {
    globalShortcut.unregisterAll();
    const failed = [];
    for (const [action, accelerator] of Object.entries(shortcuts)) {
        if (!accelerator) continue;
        let ok = false;
        try {
            ok = globalShortcut.register(accelerator, () => onAction(action));
        } catch {
            ok = false;
        }
        if (!ok) failed.push(action);
    }
    return failed;
}

module.exports = { applyShortcuts };
