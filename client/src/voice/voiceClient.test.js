// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stand-in for livekit-client, as far as mute and deafen go. Its microphone behaves like
// LiveKit's: turning it on the first time captures and publishes (which takes a while, here
// until `capture.resolve()`), and isMicrophoneEnabled is false until that's done.
const lk = vi.hoisted(() => {
  const state = { room: null, capture: null, contexts: [] };
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  class LocalMic {
    constructor() {
      this.isMuted = false;
      this.raw = { enabled: true, stopped: false };
      this.processor = null;
    }
    get mediaStreamTrack() { return this.processor?.processedTrack ?? this.raw; }
    getProcessor() { return this.processor; }
    async setProcessor(processor) {
      this.processor = processor;
      processor.processedTrack = { enabled: true };
    }
    async mute() {
      this.isMuted = true;
      this.raw.stopped = true;
      this.raw.enabled = false;
    }
    async unmute() {
      if (!this.isMuted) return;
      this.raw = { enabled: true, stopped: false };
      if (this.processor) this.processor.processedTrack = { enabled: true };
      this.isMuted = false;
    }
    async restartTrack() {
      this.raw = { enabled: !this.isMuted, stopped: false };
      if (this.processor) this.processor.processedTrack = { enabled: true };
    }
  }
  class LocalParticipant {
    constructor() {
      this.identity = '1';
      this.permissions = undefined;
      this.mic = null;
      this.pending = null;
      this.isScreenShareEnabled = false;
    }
    get isMicrophoneEnabled() { return Boolean(this.mic && !this.mic.isMuted); }
    getTrackPublication(source) {
      if (source !== 'microphone' || !this.mic) return undefined;
      const track = this.mic;
      return { track, audioTrack: track, get isMuted() { return track.isMuted; } };
    }
    async setMicrophoneEnabled(enabled) {
      if (enabled) {
        if (this.mic) await this.mic.unmute();
        else if (this.pending) await this.pending;
        else {
          this.pending = state.capture.promise.then(() => { this.mic = new LocalMic(); this.pending = null; });
          await this.pending;
        }
        return this.getTrackPublication('microphone');
      }
      if (!this.mic && this.pending) await this.pending;
      await this.mic?.mute();
      return this.getTrackPublication('microphone');
    }
    async unpublishTrack(track) {
      if (track === this.mic) this.mic = null;
    }
  }
  // LiveKit's remote audio: its volume is a gain it rebuilds now and then (a second element,
  // a new AudioContext), re-applying the last volume only if it isn't 0.
  class RemoteAudioTrack {
    constructor() {
      this.kind = 'audio';
      this.attachedElements = [];
      this.plugins = [];
      this.elementVolume = undefined;
      this.liveKitGain = 1;
      this.mediaStreamTrack = {};
    }
    setWebAudioPlugins(nodes) { this.plugins = nodes; }
    setVolume(volume) {
      this.liveKitGain = volume;
      for (const element of this.attachedElements) element.volume = Math.min(1, volume);
      this.elementVolume = volume;
    }
    attach() {
      const element = document.createElement('audio');
      this.attachedElements.push(element);
      return element;
    }
    detach() { return this.attachedElements.splice(0); }
    rebuildGraph() { this.liveKitGain = this.elementVolume ? this.elementVolume : 1; }
    // What reaches the speakers, as a factor of the voice.
    get heardAt() {
      return this.plugins.reduce((level, node) => level * node.gain.value, 1) * this.liveKitGain;
    }
  }
  class Room {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.localParticipant = new LocalParticipant();
      this.remoteParticipants = new Map();
      this.canPlaybackAudio = true;
      state.room = this;
    }
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }
    emit(event, ...args) { this.handlers[event]?.(...args); }
    async connect() {}
    async startAudio() {}
    async disconnect() {}
    removeAllListeners() {}
    async switchActiveDevice() {}
  }
  const RoomEvent = new Proxy({}, { get: (_, name) => name });
  return {
    state,
    deferred,
    RemoteAudioTrack,
    module: {
      Room,
      RoomEvent,
      Track: {
        Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' },
        Kind: { Audio: 'audio', Video: 'video' },
      },
    },
  };
});

vi.mock('livekit-client', () => lk.module);
vi.mock('../services/voiceService', () => ({
  fetchVoiceToken: vi.fn(async () => ({ url: 'wss://lk', token: 'token' })),
  saveVoiceState: vi.fn(async () => {}),
  leaveVoiceChannel: vi.fn(async () => {}),
}));
vi.mock('../sounds/sounds', () => ({ playSound: vi.fn() }));
vi.mock('./noise/noiseStages', () => ({ VOICE_SAMPLE_RATE: 48000, voiceProcessingStage: vi.fn() }));
vi.mock('./speaking', () => ({
  createSpeakingMeters: () => ({ add() {}, remove() {}, destroy() {} }),
  whoIsSpeaking: () => [],
}));

// Others' voices through Web Audio (`playback`): an AudioContext whose gains are plain values.
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    lk.state.contexts.push(this);
  }
  createGain() {
    return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} } };
  }
  async resume() {}
  async close() { this.state = 'closed'; }
}
FakeAudioContext.prototype.setSinkId = async () => {};
globalThis.AudioContext = FakeAudioContext;

const voice = await import('./voiceClient');
const { setStreamVolume, setUserVolume } = await import('./userVolumes');

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// What our microphone sends: nothing unless there's a track that's on, not stopped.
const sending = () => {
  const mic = lk.state.room.localParticipant.mic;
  if (!mic || mic.isMuted) return false;
  return mic.mediaStreamTrack.enabled !== false && !mic.raw.stopped;
};

async function joinMuted() {
  lk.state.capture = lk.deferred();
  voice.setSelfDeaf(false);
  voice.setSelfMute(true);
  await voice.joinVoice(1, 2);
  expect(voice.getVoiceSnapshot().status).toBe('connected');
}

describe('voiceClient mute and deafen', () => {
  beforeEach(async () => {
    await voice.leaveVoice();
  });

  it('a mute while the microphone is still being captured is never lost', async () => {
    await joinMuted();
    voice.setSelfMute(false);
    await flush();
    voice.setSelfMute(true);
    lk.state.capture.resolve();
    await flush();
    expect(voice.getVoiceSnapshot().selfMute).toBe(true);
    expect(sending()).toBe(false);
  });

  it('deafening while the microphone is still being captured keeps it off', async () => {
    await joinMuted();
    voice.setSelfMute(false);
    await flush();
    voice.setSelfDeaf(true);
    lk.state.capture.resolve();
    await flush();
    expect(sending()).toBe(false);
  });

  it('mute and unmute quickly in turn end in the last one', async () => {
    await joinMuted();
    voice.setSelfMute(false);
    voice.setSelfMute(true);
    voice.setSelfMute(false);
    lk.state.capture.resolve();
    await flush();
    expect(sending()).toBe(true);
    voice.setSelfMute(true);
    voice.setSelfMute(false);
    voice.setSelfMute(true);
    await flush();
    expect(sending()).toBe(false);
    voice.setSelfMute(false);
    await flush();
    expect(sending()).toBe(true);
  });

  it('deafened, a voice stays silent when LiveKit rebuilds its audio', async () => {
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    voice.setSelfMute(false);
    voice.setSelfDeaf(false);
    await voice.joinVoice(1, 2);
    const room = lk.state.room;
    const track = new lk.RemoteAudioTrack();
    const publication = { source: 'microphone', track, setSubscribed() {} };
    const participant = {
      identity: '7',
      isMicrophoneEnabled: true,
      trackPublications: new Map([['a', publication]]),
      audioTrackPublications: new Map([['a', publication]]),
      getTrackPublication: () => undefined,
    };
    room.remoteParticipants.set('7', participant);
    room.emit('TrackSubscribed', track, publication, participant);
    expect(track.heardAt).toBe(1);

    voice.setSelfDeaf(true);
    expect(track.heardAt).toBe(0);
    track.rebuildGraph();
    expect(track.heardAt).toBe(0);

    voice.setSelfDeaf(false);
    expect(track.heardAt).toBe(1);
  });

  it('a stream’s sound follows the stream’s volume, the microphone the person’s', async () => {
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    voice.setSelfMute(false);
    voice.setSelfDeaf(false);
    await voice.joinVoice(1, 2);
    const room = lk.state.room;
    const mic = new lk.RemoteAudioTrack();
    const sound = new lk.RemoteAudioTrack();
    const micPublication = { source: 'microphone', track: mic, setSubscribed() {} };
    const soundPublication = { source: 'screen_share_audio', track: sound, setSubscribed() {} };
    const participant = {
      identity: '8',
      isMicrophoneEnabled: true,
      trackPublications: new Map([['a', micPublication], ['b', soundPublication]]),
      audioTrackPublications: new Map([['a', micPublication], ['b', soundPublication]]),
      getTrackPublication: () => undefined,
    };
    room.remoteParticipants.set('8', participant);
    room.emit('TrackSubscribed', mic, micPublication, participant);
    room.emit('TrackSubscribed', sound, soundPublication, participant);

    setStreamVolume('8', 0.25);
    expect(sound.heardAt).toBe(0.25);
    expect(mic.heardAt).toBe(1);
    setUserVolume('8', 1.5);
    expect(mic.heardAt).toBe(1.5);
    expect(sound.heardAt).toBe(0.25);
    setStreamVolume('8', 1);
    setUserVolume('8', 1);
  });
});
