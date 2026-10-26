import { useSyncExternalStore } from 'react';
import { faBan, faFlag } from '@fortawesome/free-solid-svg-icons';
import { isBlocked, isWebhookBlocked, unblockUser, unblockWebhook } from './blocks';
import { t } from '../i18n';

// Block / Unblock and Report in right-click menus (a person, a webhook), like Discord's. A menu
// closes on a pick, so what Block and Report open (asking first, the report form) is kept here
// and drawn by SafetyDialogs (mounted once in App): { kind: 'block' | 'report' | 'unfriend', userId,
// name }, { kind: 'transfer' | 'kick' | 'ban', guild, userId, name } (a person's menu,
// utils/personMenu.js), { kind: 'make-admin' | 'remove-admin' | 'suspend', userId, name } (the
// same, for global admins) or { kind: 'block-webhook', webhookId, name }. Unblocking needs no asking.

let dialog = null;
const listeners = new Set();

export function openSafetyDialog(next) {
  dialog = next;
  listeners.forEach((listener) => listener());
}

export const closeSafetyDialog = () => openSafetyDialog(null);

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The open dialog, or null.
export const getSafetyDialog = () => dialog;

export function useSafetyDialog() {
  return useSyncExternalStore(subscribe, getSafetyDialog);
}

// Block (or Unblock) and Report for user `userId` (shown as `name`), none for yourself (`meId`).
export function userSafetyItems(userId, name, meId) {
  if (userId == null || meId == null || Number(userId) === Number(meId)) return [];
  return [
    isBlocked(userId)
      ? { key: 'unblock', label: t('chat.blocked.unblock'), icon: faBan, onSelect: () => unblockUser(userId) }
      : { key: 'block', label: t('chat.blocked.block'), icon: faBan, danger: true, onSelect: () => openSafetyDialog({ kind: 'block', userId, name }) },
    { key: 'report', label: t('chat.report.menuUser'), icon: faFlag, danger: true, onSelect: () => openSafetyDialog({ kind: 'report', userId, name }) },
  ];
}

// Block Webhook (or Unblock Webhook) for webhook `webhookId`. Its messages are reported from
// the message menu (against the guild's owner).
export function webhookSafetyItems(webhookId, name) {
  if (webhookId == null) return [];
  return [isWebhookBlocked(webhookId)
    ? { key: 'unblock-webhook', label: t('chat.blocked.unblockWebhook'), icon: faBan, onSelect: () => unblockWebhook(webhookId) }
    : { key: 'block-webhook', label: t('chat.blocked.blockWebhook'), icon: faBan, danger: true, onSelect: () => openSafetyDialog({ kind: 'block-webhook', webhookId, name }) }];
}
