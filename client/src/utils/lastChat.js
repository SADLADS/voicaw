// The chat the app reopens on (on this device): the last DM, group DM, conversation with a bot,
// Notes or guild viewed. Pages that aren't a chat (Settings, Friends, the developer portal...)
// leave it as it was. A guild is kept without its channel: it reopens on its own last text,
// list or document channel (utils/guildDisplay.js defaultChannel), never a voice one.
// Account data: forgotten on logout (services/logout.js).
export const LAST_CHAT_KEY = 'lastChat';

const DM = /^\/dm\/(notes|g\/[0-9a-f-]+|b\/\d+|[^/]+)$/;
const GUILD = /^\/guild\/(\d+)(?:\/\d+)?$/;

// The page a path is a chat on, or null if it isn't one.
export function chatPath(pathname) {
  if (DM.test(pathname)) return pathname === '/dm/friends' ? null : pathname;
  const guild = GUILD.exec(pathname);
  return guild ? `/guild/${guild[1]}` : null;
}

export function rememberChat(pathname) {
  const path = chatPath(pathname);
  if (!path) return;
  try {
    localStorage.setItem(LAST_CHAT_KEY, path);
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

export function forgetChat() {
  try {
    localStorage.removeItem(LAST_CHAT_KEY);
  } catch {
    // Storage unavailable.
  }
}
