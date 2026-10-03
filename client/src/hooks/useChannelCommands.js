import { useCallback, useEffect, useState } from 'react';
import { fetchCommands } from '../services/interactionService';

// The bot commands someone may use in a guild channel (interactionService.fetchCommands), kept
// for a little while per channel so the "/" picker and the Apps menus open at once; asked
// again (in the background) whenever one opens after that. `enabled` false: none, and nothing
// is fetched (DMs, groups, notes, document channels: bots are never there).
const FRESH_MS = 30000;
const cache = new Map(); // channel id -> { at, commands }
const pending = new Map(); // channel id -> promise

export function loadChannelCommands(channelId, { fresh = false } = {}) {
  const cached = cache.get(channelId);
  if (!fresh && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.commands);
  if (pending.has(channelId)) return pending.get(channelId);
  const request = fetchCommands(channelId)
    .then((commands) => {
      cache.set(channelId, { at: Date.now(), commands });
      return commands;
    })
    .finally(() => pending.delete(channelId));
  pending.set(channelId, request);
  return request;
}

// For tests.
export function clearCommandCache() {
  cache.clear();
  pending.clear();
}

export function useChannelCommands(channelId, { enabled = true } = {}) {
  const active = enabled && channelId != null;
  const [commands, setCommands] = useState(() => (active ? cache.get(channelId)?.commands ?? [] : []));

  const refresh = useCallback((options) => {
    if (channelId == null) return Promise.resolve([]);
    return loadChannelCommands(channelId, options).then((list) => {
      setCommands(list);
      return list;
    }, () => []);
  }, [channelId]);

  useEffect(() => {
    if (!active) {
      setCommands([]);
      return undefined;
    }
    let cancelled = false;
    setCommands(cache.get(channelId)?.commands ?? []);
    loadChannelCommands(channelId).then((list) => { if (!cancelled) setCommands(list); }, () => {});
    return () => { cancelled = true; };
  }, [active, channelId]);

  return { commands: active ? commands : [], refresh };
}
