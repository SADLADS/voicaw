import api from '../utils/api';
import { getPrivacyPrefs } from '../utils/privacy';

// Telling the others in a chat that you're typing (server routes/typing.js): at most every
// RESEND_MS while the message box has text, since they forget it after TYPING_MS
// (utils/typing.js). Never for notes, and not when Settings → Privacy turns it off. In DMs and
// group DMs this lets the server see when you type to whom, never what.

export const RESEND_MS = 8000;
// The server takes one a second per chat; told it was too soon (typing again straight after
// sending), it's tried again after this, unless the message was sent or the box emptied first.
export const RETRY_MS = 1000;

const lastSent = new Map(); // chatId -> ms
const retries = new Map(); // chatId -> timer

export function noteTyping(chatId) {
  if (chatId == null || chatId === 'notes' || !getPrivacyPrefs().sendTyping) return;
  chatId = String(chatId);
  const now = Date.now();
  if (retries.has(chatId) || now - (lastSent.get(chatId) ?? 0) < RESEND_MS) return;
  lastSent.set(chatId, now);
  post(chatId, now);
}

async function post(chatId, sentAt) {
  try {
    await api.post('/typing', { chatId });
  } catch (err) {
    // Only a hint; nothing to tell anyone, apart from trying again when it was too soon.
    if (err.response?.status !== 429 || lastSent.get(chatId) !== sentAt) return;
    retries.set(chatId, setTimeout(() => {
      retries.delete(chatId);
      lastSent.set(chatId, Date.now());
      post(chatId, lastSent.get(chatId));
    }, RETRY_MS));
  }
}

// Sent the message, or emptied the box: the others stop showing you as typing when the message
// arrives (or after a while), so typing again should tell them again straight away.
export function typingDone(chatId) {
  chatId = String(chatId);
  lastSent.delete(chatId);
  clearTimeout(retries.get(chatId));
  retries.delete(chatId);
}
