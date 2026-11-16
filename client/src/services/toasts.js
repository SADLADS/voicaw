import { useSyncExternalStore } from 'react';
import { describeError } from '../utils/errors';
import { connectionTrouble } from '../utils/connection';

// Toasts (Errors in docs/client.md): a failure of something that happens out of view (pinning,
// reacting, a setting saved from a menu), shown above the message box for a few seconds.
// Callable from anywhere; Toasts.jsx draws them. At most three; the oldest goes first.

const MAX = 3;
const SHOW_MS = 6000;
const SHOW_WITH_RETRY_MS = 10000;

let toasts = [];
let nextId = 1;
const timers = new Map();
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

export function dismissToast(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== before) emit();
}

// `title`: what didn't happen ("Couldn't pin that message"); `error`: what was thrown, or text.
// `onRetry` adds Retry. Errors of the 'offline' kind aren't shown while the connection strip
// already says Voicaw can't be reached. -> the toast's id, or null.
export function showErrorToast(title, error, { onRetry } = {}) {
  const info = describeError(error);
  if (info.kind === 'offline' && connectionTrouble()) return null;
  const id = nextId++;
  const toast = { id, title, text: info.text, onRetry: onRetry && info.retryable ? onRetry : null };
  toasts = [...toasts, toast].slice(-MAX);
  for (const [timerId, timer] of timers) {
    if (!toasts.some((t) => t.id === timerId)) {
      clearTimeout(timer);
      timers.delete(timerId);
    }
  }
  timers.set(id, setTimeout(() => dismissToast(id), toast.onRetry ? SHOW_WITH_RETRY_MS : SHOW_MS));
  emit();
  return id;
}

export function clearToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getToasts = () => toasts;

export function useToasts() {
  return useSyncExternalStore(subscribe, () => toasts);
}
