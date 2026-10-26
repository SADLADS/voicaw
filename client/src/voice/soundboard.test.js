// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

let guildListener = null;
const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock('../utils/api', () => ({ default: api }));
vi.mock('../utils/ws-client', () => ({
  onConnectionState: () => () => {},
  onGuildEvent: (listener) => {
    guildListener = listener;
    return () => { guildListener = null; };
  },
}));
const played = [];
const stopped = [];
vi.mock('../sounds/sounds', () => ({
  playClip: (url, options) => {
    const index = played.push({ url, ...options }) - 1;
    return Promise.resolve(() => stopped.push(index));
  },
}));
let voice = { status: 'connected', callId: null, channelId: 7, selfDeaf: false };
vi.mock('./voiceClient', () => ({ getVoiceSnapshot: () => voice }));
let settings;
vi.mock('./audioSettings', () => ({ getAudioSettings: () => settings }));

const { effectVolume, initSoundboard, setJoinSound, setSoundboardBase, useJoinSound, MAX_SECONDS } = await import('./soundboard');
const { renderHook, act } = await import('@testing-library/react');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const sound = { id: 3, guild_id: 1, name: 'Horn', emoji: '📯', volume: 0.5 };
const playEvent = (changes = {}) => ({ type: 'guild_soundboard_play', guildId: 1, channelId: 7, userId: 9, join: false, sound, ...changes });

beforeEach(() => {
  played.length = 0;
  stopped.length = 0;
  voice = { status: 'connected', callId: null, channelId: 7, selfDeaf: false };
  settings = { outputVolume: 0.8, soundboardOn: true, soundboardVolume: 0.5, joinSoundsOn: true, joinSoundVolume: 1 };
  setSoundboardBase('https://s3.test');
  initSoundboard({ id: 1 }); // stops the last test's sounds
  played.length = 0;
  stopped.length = 0;
});

describe('soundboard', () => {
  it('plays sounds at their kind\'s volume × the sound\'s × the output', () => {
    expect(effectVolume({ join: false, sound }, voice, settings)).toBeCloseTo(0.5 * 0.5 * 0.8);
    expect(effectVolume({ join: true, sound }, voice, settings)).toBeCloseTo(1 * 0.5 * 0.8);
  });

  it('plays nothing deafened, in a call, or for a kind that is off', () => {
    expect(effectVolume({ join: false, sound }, { ...voice, selfDeaf: true }, settings)).toBe(0);
    expect(effectVolume({ join: false, sound }, { ...voice, callId: 4 }, settings)).toBe(0);
    expect(effectVolume({ join: false, sound }, voice, { ...settings, soundboardOn: false })).toBe(0);
    expect(effectVolume({ join: true, sound }, voice, { ...settings, joinSoundsOn: false })).toBe(0);
    // Each kind is muted on its own.
    expect(effectVolume({ join: false, sound }, voice, { ...settings, joinSoundsOn: false })).toBeGreaterThan(0);
  });

  it('plays a sound from the event only on the device in that channel, cut at 5.2 s', () => {
    guildListener(playEvent());
    expect(played).toEqual([{ url: 'https://s3.test/sounds/3', volume: expect.closeTo(0.2), maxSeconds: MAX_SECONDS }]);
    guildListener(playEvent({ channelId: 8 }));
    voice = { ...voice, status: 'idle', channelId: null };
    guildListener(playEvent());
    expect(played).toHaveLength(1);
  });

  it('stops a person\'s sound when they play another, not anyone else\'s', async () => {
    guildListener(playEvent());
    await flush();
    guildListener(playEvent({ userId: 10 }));
    await flush();
    guildListener(playEvent({ sound: { ...sound, id: 4 } }));
    await flush();
    expect(played.map((p) => p.url)).toEqual(['https://s3.test/sounds/3', 'https://s3.test/sounds/3', 'https://s3.test/sounds/4']);
    // Only user 9's first.
    expect(stopped).toEqual([0]);
    // One played while the one before was still loading: that one is stopped when it starts.
    guildListener(playEvent({ userId: 10, sound: { ...sound, id: 5 } }));
    guildListener(playEvent({ userId: 10, sound: { ...sound, id: 6 } }));
    await flush();
    expect(stopped.sort()).toEqual([0, 1, 3]);
  });

  it('stops a person\'s sound even when their next one isn\'t heard here', async () => {
    guildListener(playEvent());
    await flush();
    settings = { ...settings, soundboardOn: false };
    guildListener(playEvent({ sound: { ...sound, id: 4 } }));
    expect(stopped).toEqual([0]);
    expect(played).toHaveLength(1);
  });
});

describe('join sound', () => {
  it('loads your join sound and follows changes from your other devices', async () => {
    api.get.mockResolvedValue({ data: { join_sound_id: 3, guilds: [{ id: 1, name: 'G', sounds: [sound] }] } });
    const { result } = renderHook(() => useJoinSound());
    await act(flush);
    expect(api.get).toHaveBeenCalledWith('/soundboard/join-sound');
    expect(result.current).toEqual({ joinSoundId: 3, guilds: [{ id: 1, name: 'G', sounds: [sound] }] });
    act(() => guildListener({ type: 'guild_join_sound', soundId: null }));
    expect(result.current.joinSoundId).toBe(null);

    api.put.mockResolvedValue({ data: { join_sound_id: 3 } });
    await act(() => setJoinSound(3));
    expect(api.put).toHaveBeenCalledWith('/soundboard/join-sound', { soundId: 3 });
    expect(result.current.joinSoundId).toBe(3);
  });
});
