// The chat the app reopens on (on this device): the last DM, group DM, conversation with a bot,
// Notes or guild viewed. Pages that aren't a chat (Settings, Friends, the developer portal...)
// leave it as it was. A guild is kept without its channel: it reopens on its own last text,
// list or document channel (utils/guildDisplay.js defaultChannel), never a voice one.
// Separately, the last page on the DM side (a chat or Friends), which the rail's Direct Messages
// button goes back to from a guild.
// Account data: forgotten on logout (services/logout.js).
export const LAST_CHAT_KEY = 'lastChat';
export const LAST_DM_KEY = 'lastDm';

const DM = /^\/dm\/(notes|g\/[0-9a-f-]+|b\/\d+|[^/]+)$/;
const GUILD = /^\/guild\/(\d+)(?:\/\d+)?$/;

// The page a path is a chat on, or null if it isn't one.
export function chatPath(pathname) {
  if (DM.test(pathname)) return pathname === '/dm/friends' ? null : pathname;
  const guild = GUILD.exec(pathname);
  return guild ? `/guild/${guild[1]}` : null;
}

// The DM-side page a path is, or null if it isn't one.
export function dmPath(pathname) {
  return DM.test(pathname) ? pathname : null;
}

export function rememberChat(pathname) {
  const chat = chatPath(pathname);
  const dm = dmPath(pathname);
  try {
    if (chat) localStorage.setItem(LAST_CHAT_KEY, chat);
    if (dm) localStorage.setItem(LAST_DM_KEY, dm);
  } catch {
    // Storage unavailable.
  }
}

export function lastChat() {
  try {
    return chatPath(localStorage.getItem(LAST_CHAT_KEY) ?? '');
  } catch {
    return null;
  }
}

export function lastDm() {
  try {
    return dmPath(localStorage.getItem(LAST_DM_KEY) ?? '');
  } catch {
    return null;
  }
}

// Forgets a chat that's gone: wherever it's remembered, or everything without one.
export function forgetChat(pathname) {
  try {
    for (const [key, path] of [[LAST_CHAT_KEY, chatPath(pathname ?? '')], [LAST_DM_KEY, dmPath(pathname ?? '')]]) {
      if (pathname == null || localStorage.getItem(key) === path) localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable.
  }
}
