// Push to talk while another app has focus (a game): Electron's global shortcuts only report
// presses, never releases, so holding a key needs a keyboard hook of the system's
// (uiohook-napi: a low-level hook on Windows, XRecord on X11, an event tap on macOS, which
// asks for Accessibility in System Settings). It runs only while the page asks for it (in
// voice, with push to talk on and a key chosen: hooks/useDesktopApp.js), and tells the page
// nothing but that key going down and up; every other key and button is ignored here.
// Wayland apps' keys aren't seen (only X11 and XWayland ones): there it works while Voicaw
// itself has focus, as in a browser.

// The page's key (client voice/pushToTalkKeys.js, KeyboardEvent.code, or "Mouse3"-"Mouse5")
// → the hook's name for it (uiohook-napi's UiohookKey) or mouse button number.
const NAMES = {
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', AltLeft: 'Alt', AltRight: 'AltRight',
    ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
};
for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') NAMES[`Key${l}`] = l;
for (const d of '0123456789') {
    NAMES[`Digit${d}`] = d;
    NAMES[`Numpad${d}`] = `Numpad${d}`;
}
for (let i = 1; i <= 24; i++) NAMES[`F${i}`] = `F${i}`;
for (const same of [
    'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide',
    'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma',
    'Period', 'Slash', 'CapsLock', 'Space', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'NumLock', 'ScrollLock', 'PrintScreen',
]) NAMES[same] = same;
const MOUSE_BUTTONS = { Mouse3: 3, Mouse4: 4, Mouse5: 5 };

const KEYS = [...Object.keys(NAMES), ...Object.keys(MOUSE_BUTTONS)];

// `loadHook()` returns uiohook-napi's { uIOhook, UiohookKey } (loaded on first use: it's a native
// module). `onChange(down)` is called as the key goes down and up.
function createPushToTalk({ loadHook = () => require('uiohook-napi'), onChange }) {
    let lib = null;
    let running = false;
    let wanted = null; // { keycode } or { button }
    let down = false;

    const press = (isDown) => {
        if (down === isDown) return;
        down = isDown;
        onChange(isDown);
    };
    const onKey = (isDown) => (e) => { if (wanted?.keycode === e.keycode) press(isDown); };
    const onMouse = (isDown) => (e) => { if (wanted?.button === e.button) press(isDown); };
    const listeners = {
        keydown: onKey(true), keyup: onKey(false), mousedown: onMouse(true), mouseup: onMouse(false),
    };

    function stop() {
        press(false);
        if (!running) return;
        running = false;
        for (const [event, listener] of Object.entries(listeners)) lib.uIOhook.off(event, listener);
        try {
            lib.uIOhook.stop();
        } catch (err) {
            console.error('Could not stop the push to talk hook', err.message);
        }
    }

    // Listens for `key` (null: stops). Resolves whether it's listening.
    function set(key) {
        if (key == null || !KEYS.includes(key)) {
            wanted = null;
            stop();
            return key == null;
        }
        try {
            lib ??= loadHook();
            const next = key in MOUSE_BUTTONS ? { button: MOUSE_BUTTONS[key] } : { keycode: lib.UiohookKey[NAMES[key]] };
            if (next.keycode === undefined && next.button === undefined) throw new Error(`No hook key for ${key}`);
            if (wanted && (wanted.keycode !== next.keycode || wanted.button !== next.button)) press(false);
            wanted = next;
            if (!running) {
                for (const [event, listener] of Object.entries(listeners)) lib.uIOhook.on(event, listener);
                running = true;
                lib.uIOhook.start();
            }
            return true;
        } catch (err) {
            console.error('Push to talk outside Voicaw is unavailable', err.message);
            wanted = null;
            stop();
            return false;
        }
    }

    return { set, stop };
}

module.exports = { createPushToTalk, PUSH_TO_TALK_KEYS: KEYS };
