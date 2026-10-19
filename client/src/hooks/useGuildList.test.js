// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let emit;
let setConnection;
vi.mock('../utils/ws-client', () => ({
  onGuildEvent: (callback) => {
    emit = callback;
    return () => {};
  },
  onConnectionState: (callback) => {
    setConnection = callback;
    return () => {};
  },
}));
vi.mock('../services/guildService', () => ({
  fetchGuilds: vi.fn(async () => [
    { id: 5, name: 'Alpha', owner: 1, icon_version: 0, voice: { 50: [2] } },
    { id: 6, name: 'Beta', owner: 2, icon_version: 0, voice: {} },
  ]),
  fetchGuildUnread: vi.fn(async () => []),
  fetchChannelMutes: vi.fn(async () => []),
  fetchGuildMutes: vi.fn(async () => []),
  fetchChannelNotifications: vi.fn(async () => []),
  fetchAllEmojis: vi.fn(async () => []),
  fetchGuild: vi.fn(),
  saveGuildOrder: vi.fn(),
}));

import { useGuildList } from './useGuildList';
import { fetchAllEmojis, fetchGuild, fetchGuildMutes, fetchGuildUnread } from '../services/guildService';

const voiceState = (guildId, channelId, userId, joined = true) => ({
  type: 'guild_voice_state', guildId, channelId, userId, state: joined ? { user_id: userId } : null,
});

describe('useGuildList guildVoice', () => {
  it('follows who is in voice in every guild, and whether it is you', async () => {
    const { result } = renderHook(() => useGuildList({ userId: 1, activeChannelId: null }));
    await waitFor(() => expect(result.current.guildVoice).toEqual({ 5: 'others' }));
    // The list's summaries don't carry the voice map.
    expect(result.current.guilds[0]).not.toHaveProperty('voice');

    act(() => emit(voiceState(6, 60, 1)));
    expect(result.current.guildVoice).toEqual({ 5: 'others', 6: 'self' });

    // Moving channel (left the first, joined the second), then leaving.
    act(() => emit(voiceState(5, 50, 2, false)));
    act(() => emit(voiceState(5, 51, 2)));
    expect(result.current.guildVoice[5]).toBe('others');
    act(() => emit(voiceState(5, 51, 2, false)));
    expect(result.current.guildVoice).toEqual({ 6: 'self' });

    // A layout (opening the guild, or guild_update) says who's in as you can now see it.
    act(() => emit({
      type: 'guild_update',
      guild: { id: 6, name: 'Beta', owner: 2, icon_version: 0, categories: [], channels: [{ id: 61, type: 'voice', voice: [{ user_id: 3 }] }] },
    }));
    expect(result.current.guildVoice).toEqual({ 6: 'others' });
  });
});

describe('useGuildList reconnecting', () => {
  it("fetches the opened guilds' layouts again, so voice leaves missed while offline go", async () => {
    const layout = (voice) => ({ id: 5, name: 'Alpha', owner: 1, icon_version: 0, categories: [], channels: [{ id: 50, type: 'voice', voice }] });
    fetchGuild.mockResolvedValueOnce(layout([{ user_id: 2 }, { user_id: 3 }]));
    const { result } = renderHook(() => useGuildList({ userId: 1, activeChannelId: null }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(() => result.current.loadGuild(5));
    expect(result.current.layouts[5].channels[0].voice).toHaveLength(2);

    // Offline (a phone's app in the background) while both leave: no event reaches it.
    act(() => setConnection('connecting'));
    fetchGuild.mockClear();
    fetchGuild.mockResolvedValueOnce(layout([]));
    act(() => setConnection('online'));
    await waitFor(() => expect(result.current.layouts[5].channels[0].voice).toEqual([]));
    expect(fetchGuild).toHaveBeenCalledTimes(1);
    expect(fetchGuild).toHaveBeenCalledWith('5');
    expect(result.current.guildVoice).toEqual({});
  });
});

describe('useGuildList emojis', () => {
  it("loads a guild's emoji when you join it", async () => {
    const { result } = renderHook(() => useGuildList({ userId: 1, activeChannelId: null }));
    await waitFor(() => expect(result.current.guilds).toHaveLength(2));
    expect(result.current.emojis).toEqual({});

    const emoji = { id: 70, guild_id: 7, name: 'wave', animated: 0 };
    fetchAllEmojis.mockResolvedValueOnce([emoji]);
    act(() => emit({ type: 'guild_add', guild: { id: 7, name: 'Gamma', owner: 3, icon_version: 0 } }));
    await waitFor(() => expect(result.current.emojis).toEqual({ 7: [emoji] }));

    // A guild already in the list (opening it, guild_update) doesn't fetch them again.
    const calls = fetchAllEmojis.mock.calls.length;
    act(() => emit({ type: 'guild_update', guild: { id: 7, name: 'Gamma 2', owner: 3, icon_version: 0 } }));
    expect(fetchAllEmojis).toHaveBeenCalledTimes(calls);
  });
});

describe('useGuildList guild mutes', () => {
  it("leaves a muted guild's unread messages out, but not its mentions, until unmuted or run out", async () => {
    fetchGuildUnread.mockResolvedValueOnce([
      { channel_id: 50, guild_id: 5, count: 3, mentions: 0 },
      { channel_id: 51, guild_id: 5, count: 1, mentions: 1 },
      { channel_id: 60, guild_id: 6, count: 2, mentions: 0 },
    ]);
    fetchGuildMutes.mockResolvedValueOnce([{ guild_id: 5, until: null }]);
    const { result } = renderHook(() => useGuildList({ userId: 1, activeChannelId: null }));
    await waitFor(() => expect(result.current.isGuildMuted(5)).toBe(true));
    await waitFor(() => expect(result.current.unread).toHaveLength(3));
    expect(result.current.activeUnread.map((u) => u.channel_id)).toEqual([51, 60]);
    expect(result.current.isMuted(50)).toBe(false);

    // Muted on another device for a minute; unmuted.
    const until = Math.floor(Date.now() / 1000) + 60;
    act(() => emit({ type: 'guild_mute', guildId: 6, muted: true, until }));
    expect(result.current.guildMutes[6]).toEqual({ until });
    expect(result.current.activeUnread.map((u) => u.channel_id)).toEqual([51]);
    act(() => emit({ type: 'guild_mute', guildId: 5, muted: false, until: null }));
    expect(result.current.activeUnread.map((u) => u.channel_id)).toEqual([50, 51]);

    // The timed one ends by itself.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      act(() => emit({ type: 'guild_mute', guildId: 6, muted: true, until: Math.floor(Date.now() / 1000) + 60 }));
      act(() => vi.advanceTimersByTime(61_000));
      expect(result.current.isGuildMuted(6)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    // Leaving the guild forgets its mute.
    act(() => emit({ type: 'guild_mute', guildId: 6, muted: true, until: null }));
    act(() => emit({ type: 'guild_remove', guildId: 6 }));
    expect(result.current.guildMutes).toEqual({});
  });
});
