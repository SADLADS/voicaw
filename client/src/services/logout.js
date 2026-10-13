import api from '../utils/api';
import { closeWebSocket } from '../utils/ws-client';
import { leaveVoice } from '../voice/voiceClient';
import { hangUp } from '../voice/callClient';
import { clearUserKeys } from './keyStore';
import { forgetGroups } from './groupCache';
import { disableNotificationsOnThisDevice } from './pushService';
import { clearDrafts } from './draftStore';
import { clearSearchIndex } from './searchIndex';

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
// LOGOUT_SERVER_MS carries on in the background with the token it started with.
async function endOnServer(token) {
  // Before the token goes: the server must forget this device, or it would keep
  // receiving this account's notifications after logout.
  try {
    await disableNotificationsOnThisDevice({ timeout: LOGOUT_SERVER_MS });
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

// Everything this device keeps for the logged-in account, forgotten without asking the server.
// Also what the "can't reach Voicaw" screen's Log out does: a saved login lives in
// localStorage, so clearing cookies doesn't remove it.
export async function forgetLogin() {
  try { localStorage.removeItem('token'); } catch { /* storage blocked */ }
  try {
    await clearUserKeys();
    await forgetGroups();
    await clearSearchIndex();
  } catch (err) {
    console.error('Failed to clear stored keys on logout', err);
  }
  clearDrafts();
  closeWebSocket();
}

export async function logOut() {
  const token = localStorage.getItem('token');
  if (token) await waitAtMost(endOnServer(token), LOGOUT_SERVER_MS);
  await forgetLogin();
}
