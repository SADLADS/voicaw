// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../voice/watchParty', () => ({
  expectedPosition: vi.fn(),
  reportDuration: vi.fn(),
}));

import { useWatchPartySync } from './useWatchPartySync';
import { expectedPosition, reportDuration } from '../voice/watchParty';
import { STATE } from '../voice/youtubeEmbed';

// A player that does nothing by itself: the test says what state it's in.
function fakeEmbed(info = {}) {
  return {
    info: { ready: true, playerState: STATE.UNSTARTED, duration: 0, ...info },
    time: 0,
    currentTime() { return this.time; },
    load: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
  };
}

const item = { id: 1, video_id: 'aaaaaaaaaaa', duration: null };
const party = (changes = {}) => ({ current: item, queue: [], playing: true, position: 0, updated_at: 0, ...changes });

function render(embed, initial) {
  return renderHook((props) => useWatchPartySync({ embed, ready: true, guildId: 1, channelId: 2, volume: 80, ...props }), {
    initialProps: { party: initial },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  expectedPosition.mockReturnValue(10);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWatchPartySync', () => {
  it('loads the party\'s video at the point the server says, and sets the volume', () => {
    const embed = fakeEmbed();
    render(embed, party());
    expect(embed.load).toHaveBeenCalledWith('aaaaaaaaaaa', 10, true);
    expect(embed.setVolume).toHaveBeenCalledWith(80);
  });

  it('doesn\'t load again the video the frame was opened on', () => {
    const embed = fakeEmbed({ playerState: STATE.PLAYING });
    embed.time = 10;
    renderHook(() => useWatchPartySync({ embed, ready: true, party: party(), guildId: 1, channelId: 2, volume: 80, initialItemId: 1 }));
    act(() => vi.advanceTimersByTime(1000));
    expect(embed.load).not.toHaveBeenCalled();
  });

  it('starts a video that should be playing, and gives up asking after three tries', () => {
    const embed = fakeEmbed();
    const { result } = render(embed, party());
    embed.info.playerState = STATE.PAUSED;
    embed.time = 10;
    act(() => vi.advanceTimersByTime(2000));
    expect(embed.play).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(4000));
    expect(embed.play.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.current.blocked).toBe(true);

    // A click: it plays.
    act(() => result.current.retry());
    embed.info.playerState = STATE.PLAYING;
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.blocked).toBe(false);
  });

  it('moves a playing video back into step once it drifts', () => {
    const embed = fakeEmbed();
    render(embed, party());
    embed.info.playerState = STATE.PLAYING;
    embed.time = 11;
    act(() => vi.advanceTimersByTime(3500));
    expect(embed.seek).not.toHaveBeenCalled();
    embed.time = 14;
    act(() => vi.advanceTimersByTime(500));
    expect(embed.seek).toHaveBeenCalledWith(10);
  });

  it('pauses with the party, at its point', () => {
    const embed = fakeEmbed();
    const { rerender } = render(embed, party());
    embed.info.playerState = STATE.PLAYING;
    embed.time = 20;
    rerender({ party: party({ playing: false }) });
    act(() => vi.advanceTimersByTime(500));
    expect(embed.pause).toHaveBeenCalled();
    expect(embed.seek).toHaveBeenCalledWith(10);
  });

  it('loads the next video when the party moves on, and reports lengths it learns', () => {
    const embed = fakeEmbed();
    const { rerender } = render(embed, party());
    embed.info.duration = 212;
    act(() => vi.advanceTimersByTime(500));
    expect(reportDuration).toHaveBeenCalledWith(1, 2, 1, 212);

    rerender({ party: party({ current: { id: 2, video_id: 'bbbbbbbbbbb', duration: 60 } }) });
    expect(embed.load).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(500));
    expect(embed.load).toHaveBeenLastCalledWith('bbbbbbbbbbb', 10, true);
  });
});
