import { useSyncExternalStore } from 'react';
import api from './api';

// Who you've blocked (server/blocks.js): their messages are collapsed in guilds and groups
// ("Blocked message · Show"), your DM with them is closed (no messages or calls either way), and
// you aren't notified about them. Loaded at login and kept up to date by the `blocks` event from
// your other devices (hooks/useBlocksSync.js, in Layout). Webhooks you've blocked
// ([{ id, name, guild_id, guild_name }]) have their messages collapsed the same way.

let blocked = new Set();
let webhooks = [];
let webhookIds = new Set();
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

export function applyBlocked(ids, blockedWebhooks = []) {
  blocked = new Set((ids ?? []).map(Number));
  webhooks = blockedWebhooks ?? [];
  webhookIds = new Set(webhooks.map((w) => Number(w.id)));
  notify();
}

const applyResponse = (res) => applyBlocked(res.data.blocked, res.data.webhooks);

export const isBlocked = (userId) => userId != null && blocked.has(Number(userId));
export const isWebhookBlocked = (webhookId) => webhookId != null && webhookIds.has(Number(webhookId));

export async function blockUser(userId) {
  applyResponse(await api.put(`/blocks/${userId}`));
}

export async function unblockUser(userId) {
  applyResponse(await api.delete(`/blocks/${userId}`));
}

export async function blockWebhook(webhookId) {
  applyResponse(await api.put(`/blocks/webhooks/${webhookId}`));
}

export async function unblockWebhook(webhookId) {
  applyResponse(await api.delete(`/blocks/webhooks/${webhookId}`));
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => blocked;
const webhookSnapshot = () => webhooks;
const webhookIdSnapshot = () => webhookIds;

// The blocked ids (a Set), redrawing when it changes.
export function useBlocked() {
  return useSyncExternalStore(subscribe, snapshot);
}

// The blocked webhooks ([{ id, name, guild_id, guild_name }]), redrawing when they change.
export function useBlockedWebhooks() {
  return useSyncExternalStore(subscribe, webhookSnapshot);
}

// Their ids (a Set).
export function useBlockedWebhookIds() {
  return useSyncExternalStore(subscribe, webhookIdSnapshot);
}
