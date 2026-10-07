import { useSyncExternalStore } from 'react';
import api from './api';

// Your friends and friend requests (server/friends.js): the DM list shows friends and whoever
// you have a conversation with (visibleInDmList), and the Friends page lists them. Loaded at
// login and kept up to date by the `friends` event, which both people's devices get on every
// change (hooks/useFriendsSync.js, in Layout). `admin`: the Friends page has an Everyone tab.

const EMPTY = { friends: new Set(), incoming: [], outgoing: [], admin: false, loaded: false };
let state = EMPTY;
const listeners = new Set();

// `lists`: { friends: [{ id, since }], incoming: [{ id, created_at }], outgoing, admin } from the
// server, or null to forget them (logging out).
export function applyFriends(lists) {
  state = lists
    ? {
      friends: new Set((lists.friends ?? []).map((f) => Number(f.id))),
      incoming: (lists.incoming ?? []).map((r) => ({ ...r, id: Number(r.id) })),
      outgoing: (lists.outgoing ?? []).map((r) => ({ ...r, id: Number(r.id) })),
      admin: Boolean(lists.admin),
      loaded: true,
    }
    : EMPTY;
  listeners.forEach((listener) => listener());
}

export async function loadFriends() {
  applyFriends((await api.get('/friends')).data);
}

// Each resolves to the server's `result` ('requested', 'accepted', 'friends', 'removed' or
// 'none'), having applied the new lists.
async function apply(request) {
  const { data } = await request;
  applyFriends(data);
  return data.result;
}

// Asks them, or accepts their request.
export const addFriend = (userId) => apply(api.put(`/friends/${userId}`));
export const addFriendByName = (username) => apply(api.post('/friends', { username }));
// Removes a friend, declines their request or cancels yours.
export const removeFriend = (userId) => apply(api.delete(`/friends/${userId}`));

// 'friend', 'incoming' (they asked you), 'outgoing' (you asked them) or null.
export function relationOf(friends, userId) {
  const id = Number(userId);
  if (friends.friends.has(id)) return 'friend';
  if (friends.incoming.some((r) => r.id === id)) return 'incoming';
  if (friends.outgoing.some((r) => r.id === id)) return 'outgoing';
  return null;
}

// Whether a row from /dms-list goes in the DM list: a friend, someone you have a conversation
// with, or the one open now (`activeId`).
export function visibleInDmList(friends, person, activeId) {
  return friends.friends.has(Number(person.id)) || person.last_timestamp != null || String(person.id) === String(activeId);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => state;

// { friends: Set of ids, incoming, outgoing, admin, loaded }, redrawing when it changes.
export function useFriends() {
  return useSyncExternalStore(subscribe, snapshot);
}
