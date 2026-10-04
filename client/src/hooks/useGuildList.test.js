// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let emit;
vi.mock('../utils/ws-client', () => ({
  onGuildEvent: (callback) => {
    emit = callback;
    return () => {};
  },
  onConnectionState: () => () => {},
}));
vi.mock('../services/guildService', () => ({
  fetchGuilds: vi.fn(async () => [
    { id: 5, name: 'Alpha', owner: 1, icon_version: 0, voice: { 50: [2] } },
    { id: 6, name: 'Beta', owner: 2, icon_version: 0, voice: {} },
  ]),
  fetchGuildUnread: vi.fn(async () => []),
  fetchChannelMutes: vi.fn(async () => []),
  fetchChannelNotifications: vi.fn(async () => []),
  fetchAllEmojis: vi.fn(async () => []),
  fetchGuild: vi.fn(),
  saveGuildOrder: vi.fn(),
}));

import { useGuildList } from './useGuildList';

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
