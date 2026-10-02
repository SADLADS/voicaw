import { useCallback, useEffect, useMemo, useState } from 'react';
import { onConnectionState, onConversationSettings } from '../utils/ws-client';
import { fetchConversationSettings } from '../services/dmService';

const keyOf = (kind, target) => `${kind}:${target}`;

// Your pins and mutes for DMs and group DMs (the DM list's menu; server/conversationSettings.js),
// for the whole layout (Layout puts this in LayoutContext.conversationSettings). `kind` is 'dm'
// (target: the other person's id) or 'group' (the group's id).
// - `get(kind, target)`: { pinned_at, muted, mute_until } (nothing set: not pinned or muted).
// - `isMuted(kind, target)`; a mute that runs out is dropped then.
// - `apply(setting)`: what changing one returned (also the `conversation_settings` event).
// Loaded at login and again after a reconnect (changes made elsewhere while offline).
export function useConversationSettings(userId) {
  const [settings, setSettings] = useState({});

  const apply = useCallback((setting) => {
    setSettings((prev) => {
      const { [keyOf(setting.kind, setting.target)]: _old, ...rest } = prev;
      return setting.pinned_at != null || setting.muted ? { ...rest, [keyOf(setting.kind, setting.target)]: setting } : rest;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await fetchConversationSettings();
      setSettings(Object.fromEntries(list.map((s) => [keyOf(s.kind, s.target), s])));
    } catch (err) {
      console.warn('Failed to load conversation settings', err);
    }
  }, []);

  useEffect(() => {
    if (!userId) return undefined;
    load();
    let wasOnline = true;
    const stopState = onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
    const stopEvents = onConversationSettings(apply);
    return () => {
      stopState();
      stopEvents();
      setSettings({});
    };
  }, [userId, load, apply]);

  // A mute that runs out is dropped then.
  useEffect(() => {
    const ends = Object.values(settings).filter((s) => s.muted && s.mute_until != null).map((s) => s.mute_until);
    if (!ends.length) return undefined;
    const wait = Math.max(0, Math.min(...ends) * 1000 - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now() / 1000;
      setSettings((prev) => Object.fromEntries(Object.entries(prev)
        .map(([k, s]) => [k, s.muted && s.mute_until != null && s.mute_until <= now ? { ...s, muted: false, mute_until: null } : s])
        .filter(([, s]) => s.pinned_at != null || s.muted)));
    }, Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [settings]);

  return useMemo(() => ({
    settings,
    get: (kind, target) => settings[keyOf(kind, target)] ?? { kind, target: String(target), pinned_at: null, muted: false, mute_until: null },
    isMuted: (kind, target) => Boolean(settings[keyOf(kind, target)]?.muted),
    apply,
  }), [settings, apply]);
}
