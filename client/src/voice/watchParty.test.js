import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const events = vi.hoisted(() => ({ guild: new Set(), connection: new Set() }));
vi.mock('../utils/ws-client', () => ({
  onGuildEvent: (cb) => {
    events.guild.add(cb);
    return () => events.guild.delete(cb);
  },
  onConnectionState: (cb) => {
    events.connection.add(cb);
    return () => events.connection.delete(cb);
  },
}));
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import api from '../utils/api';
import {
  expectedPosition, formatClock, getWatchParty, loadWatchParty, movedItem, reportDuration, resetWatchParties,
  serverNow, skipVideo, subscribeWatchParties, videoIdFromInput,
} from './watchParty';

const party = (changes = {}) => ({
  current: { id: 1, video_id: 'aaaaaaaaaaa', title: 'A', author: null, duration: 100, added_by: 7 },
  queue: [],
  playing: true,
  position: 10,
  updated_at: 1_000_000,
  ...changes,
});

beforeEach(() => {
  resetWatchParties();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('videoIdFromInput', () => {
  it('takes links of every kind and bare ids', () => {
    expect(videoIdFromInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('  youtu.be/dQw4w9WgXcQ ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('https://www.youtube.com/live/dQw4w9WgXcQ?si=x')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromInput('never gonna')).toBeNull();
    expect(videoIdFromInput('https://vimeo.com/123')).toBeNull();
  });
});

describe('expectedPosition', () => {
  it('moves on while playing, stops at the end, and stays put while paused', () => {
    expect(expectedPosition(party(), 1_005_000)).toBe(15);
    expect(expectedPosition(party(), 2_000_000)).toBe(100);
    expect(expectedPosition(party({ playing: false }), 1_005_000)).toBe(10);
    expect(expectedPosition(party({ current: { ...party().current, duration: null } }), 2_000_000)).toBe(1010);
    expect(expectedPosition(null)).toBe(0);
  });
});

describe('formatClock', () => {
  it('reads like a player', () => {
    expect(formatClock(7.9)).toBe('0:07');
    expect(formatClock(205)).toBe('3:25');
    expect(formatClock(3729)).toBe('1:02:09');
    expect(formatClock(undefined)).toBe('0:00');
  });
});

describe('movedItem', () => {
  it('finds the one item a drag moved, and what it now sits before', () => {
    expect(movedItem([1, 2, 3], [3, 1, 2])).toEqual({ id: 3, beforeId: 1 });
    expect(movedItem([1, 2, 3], [2, 3, 1])).toEqual({ id: 1, beforeId: null });
    expect(movedItem([1, 2, 3], [2, 1, 3])).toEqual({ id: 2, beforeId: 1 });
    expect(movedItem([1, 2, 3], [1, 2, 3])).toBeNull();
  });
});

describe('the store', () => {
  it('loads a party and sets the clock from the answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(50_000);
    api.get.mockImplementation(async () => {
      vi.setSystemTime(50_200); // a 200 ms round trip
      return { data: { party: party(), server_time: 80_000 } };
    });
    await loadWatchParty(1, 2);
    expect(api.get).toHaveBeenCalledWith('/guilds/1/channels/2/watch-party');
    expect(getWatchParty(2)).toEqual(party());
    // The server's 80 000 was half the round trip ago.
    expect(serverNow()).toBe(80_100);
  });

  it('follows events, and their server time only ever moves the clock forward', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const changed = vi.fn();
    subscribeWatchParties(changed);
    for (const cb of events.guild) cb({ type: 'guild_watch_party', guildId: 1, channelId: 2, party: party(), serverTime: 12_000 });
    expect(getWatchParty(2)).toEqual(party());
    expect(changed).toHaveBeenCalled();
    expect(serverNow()).toBe(12_000);
    for (const cb of events.guild) cb({ type: 'guild_watch_party', guildId: 1, channelId: 2, party: null, serverTime: 11_000 });
    expect(getWatchParty(2)).toBeNull();
    expect(serverNow()).toBe(12_000);
  });

  it('applies what a change answers', async () => {
    api.post.mockResolvedValue({ data: { party: null, server_time: Date.now() } });
    await skipVideo(1, 2, 5);
    expect(api.post).toHaveBeenCalledWith('/guilds/1/channels/2/watch-party/skip', { itemId: 5 });
    expect(getWatchParty(2)).toBeNull();
  });

  it('reports a video\'s length once', () => {
    api.put.mockResolvedValue({ data: { success: true } });
    reportDuration(1, 2, 9, 212.5);
    reportDuration(1, 2, 9, 212.5);
    reportDuration(1, 2, 10, 0);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/guilds/1/channels/2/watch-party/duration', { itemId: 9, duration: 212.5 });
  });
});
