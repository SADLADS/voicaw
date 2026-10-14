import api from '../utils/api';
import { SUSPENDED_NOTICE, closeWebSocket } from '../utils/ws-client';
import { leaveVoice } from '../voice/voiceClient';
import { hangUp } from '../voice/callClient';
import { clearUserKeys } from './keyStore';
import { forgetGroups } from './groupCache';
import { disableNotificationsOnThisDevice } from './pushService';
import { clearDrafts } from './draftStore';
import { clearSearchIndex } from './searchIndex';
import { clearOfflineCopy } from './offlineCopy';

// How long logging out waits for the server (turning off this device's notifications, hanging
// up, ending the session) before going on without it: a server that's down or doesn't answer
// mustn't keep anyone logged in on this device.
export const LOGOUT_SERVER_MS = 5000;

function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// The server's part of logging out, each step allowed to fail. Whatever hasn't finished after
// LOGOUT_SERVER_MS carries on in the background with the token it started with (every request
// names it: by then someone may have logged in again, and the saved token is theirs).
async function endOnServer(token) {
  // Before the token goes: the server must forget this device, or it would keep
  // receiving this account's notifications after logout.
  try {
    await disableNotificationsOnThisDevice({ timeout: LOGOUT_SERVER_MS, token });
  } catch (err) {
    console.error('Failed to turn off notifications on logout', err);
  }
  try {
    await hangUp();
    await leaveVoice();
  } catch (err) {
    console.error('Failed to leave calls on logout', err);
  }
  // The token stops working on the server too (it may already have: logged out elsewhere).
  try {
    await api.post('/logout', null, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (!err.response) console.error('Failed to end the session on logout', err);
  }
}

// localStorage keys that are about the account rather than this device: which channel each
// guild was last on, collapsed categories and tasks, the old emoji usage, the recovery prompt.
const ACCOUNT_KEYS = [/^guildChannel:/, /^taskCollapsed:/, /^collapsedCategories$/, /^emojiFrequent$/, /^recoveryPromptDismissed$/];

function forgetAccountStorage() {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key && ACCOUNT_KEYS.some((pattern) => pattern.test(key))) localStorage.removeItem(key);
  } catch { /* storage blocked */ }
  // All of sessionStorage but the login page's suspension notice (set just before this runs).
  try {
    const notice = sessionStorage.getItem(SUSPENDED_NOTICE);
    sessionStorage.clear();
    if (notice != null) sessionStorage.setItem(SUSPENDED_NOTICE, notice);
  } catch { /* storage blocked */ }
}

// Everything this device keeps for the logged-in account, forgotten without asking the server:
// the login, keys, group keys, the search and offline copies, drafts and the account's own
// localStorage entries (this device's settings stay: theme, language, sound and voice
// settings...). Also what the "can't reach Voicaw" screen's Log out does: a saved login lives
// in localStorage, so clearing cookies doesn't remove it.
export async function forgetLogin() {
  try { localStorage.removeItem('token'); } catch { /* storage blocked */ }
  const clears = [clearUserKeys, forgetGroups, clearSearchIndex, clearOfflineCopy];
  // Each on its own: one failing mustn't leave the others behind.
  await Promise.all(clears.map((clear) => clear().catch((err) => console.error('Failed to clear stored data on logout', err))));
  forgetAccountStorage();
  clearDrafts();
  closeWebSocket();
}

let loggingOut = null;

// One logout at a time: ending the session also tells this device's own socket
// (`session_revoked`, which logs out too), and a second logout running late, after logging in
// again, would end and forget the new login. Nor does one that finishes after a new login
// touch it.
export function logOut() {
  loggingOut ??= (async () => {
    const token = localStorage.getItem('token');
    if (token) await waitAtMost(endOnServer(token), LOGOUT_SERVER_MS);
    const now = localStorage.getItem('token');
    if (now && now !== token) return;
    await forgetLogin();
  })().finally(() => { loggingOut = null; });
  return loggingOut;
}
