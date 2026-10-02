import { useSyncExternalStore } from 'react';

// Who is typing where, from the server's `typing { chatId, userId }` events (see
// services/typingService.js for the sending side). Someone counts as typing for TYPING_MS after
// their last event (senders repeat it every few seconds while they type), or until their message
// arrives (clearTyping). Chat ids are the client's: the other person's id for a DM,
// `group-<id>`, `channel-<id>`, `document-<id>`.

export const TYPING_MS = 10000;

const typing = new Map(); // chatId -> Map(userId -> expiry timer)
const snapshots = new Map(); // chatId -> userIds, in the order they started typing
const listeners = new Set();
const EMPTY = [];

function changed(chatId) {
  const users = typing.get(chatId);
  if (users?.size) snapshots.set(chatId, [...users.keys()]);
  else {
    typing.delete(chatId);
    snapshots.delete(chatId);
  }
  listeners.forEach((listener) => listener());
}

export function applyTyping({ chatId, userId }) {
  if (chatId == null || userId == null) return;
  chatId = String(chatId);
  if (!typing.has(chatId)) typing.set(chatId, new Map());
  const users = typing.get(chatId);
  const isNew = !users.has(userId);
  clearTimeout(users.get(userId));
  users.set(userId, setTimeout(() => clearTyping(chatId, userId), TYPING_MS));
  if (isNew) changed(chatId);
}

// `userId` stopped typing in `chatId` (their message arrived).
export function clearTyping(chatId, userId) {
  chatId = String(chatId);
  const users = typing.get(chatId);
  if (!users?.has(userId)) return;
  clearTimeout(users.get(userId));
  users.delete(userId);
  changed(chatId);
}

// Logging out.
export function resetTyping() {
  for (const users of typing.values()) users.forEach((timer) => clearTimeout(timer));
  typing.clear();
  snapshots.clear();
  listeners.forEach((listener) => listener());
}

export function typingIn(chatId) {
  return chatId == null ? EMPTY : snapshots.get(String(chatId)) ?? EMPTY;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The ids of who is typing in `chatId`.
export function useTyping(chatId) {
  return useSyncExternalStore(subscribe, () => typingIn(chatId));
}

// "Alice is typing", "Alice and Bob are typing", "Alice, Bob and Cal are typing", then
// "Several people are typing" (like Discord), as pieces: plain strings and { name } (drawn bold).
// `names` are display names.
export function typingParts(names) {
  if (names.length === 0) return [];
  if (names.length > 3) return ['Several people are typing'];
  const parts = [];
  names.forEach((name, i) => {
    if (i > 0) parts.push(i === names.length - 1 ? ' and ' : ', ');
    parts.push({ name });
  });
  parts.push(names.length === 1 ? ' is typing' : ' are typing');
  return parts;
}
