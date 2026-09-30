// The desktop app (electron/): `desktop` is its bridge (electron/preload.js), or null in a
// browser. Everything the desktop app adds goes through here.

export const desktop = typeof window !== 'undefined' ? window.voicawDesktop ?? null : null;

export const isDesktopApp = () => desktop !== null;

// What the tray and the taskbar/dock show: `count` is what Discord counts (unread DMs and
// group messages, and mentions in guilds), `dot` whether anything at all is unread.
export function unreadSummary({ unreadDms = [], groups = [], guildUnread = [] }) {
  const dmCount = unreadDms.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const groupCount = groups.reduce((sum, group) => sum + (Number(group.unread) || 0), 0);
  const mentions = guildUnread.reduce((sum, row) => sum + (Number(row.mentions) || 0), 0);
  const count = dmCount + groupCount + mentions;
  return { count, dot: count > 0 || guildUnread.length > 0 };
}

// An Electron accelerator ("CommandOrControl+Shift+M") for a key press, or null while only
// modifiers are held (or for a key it can't name). Needs a modifier, so a shortcut can't
// take over a plain key everywhere.
const KEY_NAMES = {
  ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
};

export function acceleratorFromEvent(e, platform = desktop?.platform) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (/^Numpad[0-9]$/.test(e.code)) key = `num${e.code.slice(6)}`;
  else key = KEY_NAMES[e.key] ?? null;
  if (!key) return null;
  const parts = [];
  // On macOS Cmd is the usual modifier; elsewhere Ctrl.
  if (platform === 'darwin') {
    if (e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push('Control');
  } else {
    if (e.ctrlKey) parts.push('Control');
    if (e.metaKey) parts.push('Super');
  }
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const isFunctionKey = /^F\d+$/.test(key);
  if (!parts.length && !isFunctionKey) return null;
  return [...parts, key].join('+');
}

// How an accelerator reads ("Ctrl + Shift + M", "⌘ ⇧ M").
export function describeAccelerator(accelerator, platform = desktop?.platform) {
  if (!accelerator) return '';
  const mac = platform === 'darwin';
  const names = mac
    ? { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }
    : { Command: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Super' };
  return accelerator.split('+').map((part) => names[part] ?? part).join(mac ? ' ' : ' + ');
}
