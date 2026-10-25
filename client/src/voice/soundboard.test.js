import { describe, it, expect, vi, beforeEach } from 'vitest';

let guildListener = null;
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({
  onConnectionState: () => () => {},
  onGuildEvent: (listener) => {
    guildListener = listener;
    return () => { guildListener = null; };
  },
}));
const played = [];
vi.mock('../sounds/sounds', () => ({ playClip: (url, options) => { played.push({ url, ...options }); return Promise.resolve(null); } }));
let voice = { status: 'connected', callId: null, channelId: 7, selfDeaf: false };
vi.mock('./voiceClient', () => ({ getVoiceSnapshot: () => voice }));
let settings;
vi.mock('./audioSettings', () => ({ getAudioSettings: () => settings }));

const { effectVolume, initSoundboard, setSoundboardBase, MAX_SECONDS } = await import('./soundboard');

const sound = { id: 3, guild_id: 1, name: 'Horn', emoji: '📯', volume: 0.5 };
const playEvent = (changes = {}) => ({ type: 'guild_soundboard_play', guildId: 1, channelId: 7, userId: 9, join: false, sound, ...changes });

beforeEach(() => {
  played.length = 0;
  voice = { status: 'connected', callId: null, channelId: 7, selfDeaf: false };
  settings = { outputVolume: 0.8, soundboardOn: true, soundboardVolume: 0.5, joinSoundsOn: true, joinSoundVolume: 1 };
  setSoundboardBase('https://s3.test');
  initSoundboard({ id: 1 });
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
});
