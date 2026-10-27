import { t } from '../i18n';

// The keys and mouse buttons push to talk can use (Settings → Voice & video), saved as the
// browser's KeyboardEvent.code ("KeyV", "ControlLeft", "Backquote"), so the key is the same
// whatever the keyboard layout, or "Mouse3" (middle), "Mouse4" (back), "Mouse5" (forward).
// One key or button, no combinations (it's held, often with others while playing). The desktop
// app's global hook has the same list (electron/pushToTalk.js). Not Escape (cancels choosing),
// Backspace (clears it), Enter or Tab (they'd send or move focus with every press), nor the
// left and right mouse buttons.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `Key${l}`);
const DIGITS = '0123456789'.split('').map((d) => `Digit${d}`);
const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const NUMPAD = [
  ...'0123456789'.split('').map((d) => `Numpad${d}`),
  'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide',
];
// What these keys print, on a UK/US keyboard (shown as they are, not translated).
const SYMBOLS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadMultiply: '*', NumpadAdd: '+', NumpadSubtract: '-', NumpadDecimal: '.', NumpadDivide: '/',
};
// Named in the translations (settings.voice.pushToTalk.keys.<code>).
const NAMED = [
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight',
  'CapsLock', 'Space', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'NumLock', 'ScrollLock', 'PrintScreen',
];
export const MOUSE_BUTTONS = ['Mouse3', 'Mouse4', 'Mouse5'];
// MouseEvent.button → ours: 1 middle, 3 back, 4 forward.
const BUTTONS = { 1: 'Mouse3', 3: 'Mouse4', 4: 'Mouse5' };

export const PUSH_TO_TALK_KEYS = [
  ...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...NUMPAD,
  ...Object.keys(SYMBOLS).filter((code) => !code.startsWith('Numpad')),
  ...NAMED, ...MOUSE_BUTTONS,
];
const KEYS = new Set(PUSH_TO_TALK_KEYS);
export const NAMED_KEYS = [...NAMED, ...MOUSE_BUTTONS];

export const isPushToTalkKey = (key) => typeof key === 'string' && KEYS.has(key);

// The key a keyboard event is about, if push to talk can use it.
export function keyOfEvent(e) {
  return KEYS.has(e.code) ? e.code : null;
}

// The mouse button a mouse event is about, if push to talk can use it.
export function buttonOfEvent(e) {
  return BUTTONS[e.button] ?? null;
}

// How a key reads ("V", "`", "F13", "Numpad 4", "Left Ctrl", "Mouse 4").
export function describePushToTalkKey(key, platform = typeof navigator !== 'undefined' ? navigator.platform : '') {
  if (!isPushToTalkKey(key)) return '';
  if (key.startsWith('Key')) return key.slice(3);
  if (key.startsWith('Digit')) return key.slice(5);
  if (/^F\d+$/.test(key)) return key;
  if (/^Numpad\d$/.test(key)) return t('settings.voice.pushToTalk.keys.numpad', { key: key.slice(6) });
  if (key.startsWith('Numpad')) return t('settings.voice.pushToTalk.keys.numpad', { key: SYMBOLS[key] });
  if (SYMBOLS[key]) return SYMBOLS[key];
  // The Command and Option keys on a Mac, Super on Linux.
  if (/^Mac/i.test(platform) || platform === 'darwin') {
    if (key.startsWith('Meta') || key.startsWith('Alt')) return t(`settings.voice.pushToTalk.keys.mac.${key}`);
  } else if (/linux/i.test(platform) && key.startsWith('Meta')) {
    return t(`settings.voice.pushToTalk.keys.linux.${key}`);
  }
  return t(`settings.voice.pushToTalk.keys.${key}`);
}
