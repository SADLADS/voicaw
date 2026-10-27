// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stand-in for livekit-client, as far as mute and deafen go. Its microphone behaves like
// LiveKit's: turning it on the first time captures and publishes (which takes a while, here
// until `capture.resolve()`), and isMicrophoneEnabled is false until that's done.
const lk = vi.hoisted(() => {
  const state = { room: null, capture: null, contexts: [], permissions: undefined, screenShares: [] };
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
      const parameters = { encodings: [{ maxBitrate: undefined }] };
      this.sender = {
        getParameters: () => structuredClone(parameters),
        setParameters: async (p) => { parameters.encodings = p.encodings; },
      };
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
  // The camera: restarting it on another camera (switchCamera) fails while `state.cameraFails`.
  class LocalCamera {
    constructor(options) {
      this.options = options;
      this.restarts = [];
    }
    get mediaStreamTrack() { return { getSettings: () => ({ facingMode: this.options.facingMode }) }; }
    async restartTrack(options) {
      this.restarts.push(options);
      if (state.cameraFails) throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
      this.options = options;
    }
  }
  class LocalParticipant {
    constructor() {
      this.identity = '1';
      this.permissions = state.permissions;
      this.mic = null;
      this.pending = null;
      this.isScreenShareEnabled = false;
    }
    get isMicrophoneEnabled() { return Boolean(this.mic && !this.mic.isMuted); }
    getTrackPublication(source) {
      if (source === 'camera') return this.camera ? { track: this.camera, isMuted: false } : undefined;
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
      if (track === this.camera) this.camera = null;
    }
    async setCameraEnabled(enabled, options) {
      this.camera = enabled ? new LocalCamera(options) : null;
    }
    async setScreenShareEnabled(enabled, capture, publish) {
      state.screenShares.push({ enabled, capture, publish });
      this.isScreenShareEnabled = enabled;
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
    LocalCamera,
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
  saveWatching: vi.fn(async () => {}),
  leaveVoiceChannel: vi.fn(async () => {}),
}));
vi.mock('../sounds/sounds', () => ({ playSound: vi.fn() }));
// The server's guild events (onGuildEvent), sent by the tests.
const guildEvents = vi.hoisted(() => ({ listeners: [] }));
vi.mock('../utils/ws-client', () => ({ onGuildEvent: (cb) => guildEvents.listeners.push(cb) }));
const sendGuildEvent = (event) => guildEvents.listeners.forEach((cb) => cb(event));
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

  it('the mic test mutes and deafens until it ends, then puts both back', async () => {
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    voice.setSelfMute(false);
    voice.setSelfDeaf(false);
    await voice.joinVoice(1, 2);
    await flush();
    expect(sending()).toBe(true);

    voice.setMicTesting(true);
    await flush();
    expect(voice.getVoiceSnapshot()).toMatchObject({ selfMute: true, selfDeaf: true, micTesting: true });
    expect(sending()).toBe(false);
    // Remembered as before the test, and the buttons can't let go of it.
    expect(JSON.parse(localStorage.getItem('voicePrefs'))).toEqual({ selfMute: false, selfDeaf: false });
    voice.setSelfDeaf(false);
    voice.setSelfMute(false);
    await flush();
    expect(sending()).toBe(false);

    voice.setMicTesting(false);
    await flush();
    expect(voice.getVoiceSnapshot()).toMatchObject({ selfMute: false, selfDeaf: false, micTesting: false });
    expect(sending()).toBe(true);
  });

  it('after the mic test, someone already muted stays muted', async () => {
    voice.setSelfDeaf(false);
    voice.setSelfMute(true);
    voice.setMicTesting(true);
    voice.setMicTesting(false);
    expect(voice.getVoiceSnapshot()).toMatchObject({ selfMute: true, selfDeaf: false });
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

describe('voiceClient channel settings', () => {
  beforeEach(async () => {
    await voice.leaveVoice();
  });

  it('sends the microphone at the channel\'s bitrate, and follows a change', async () => {
    const { fetchVoiceToken } = await import('../services/voiceService');
    fetchVoiceToken.mockResolvedValueOnce({ url: 'wss://lk', token: 'token', bitrate: 96000 });
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    voice.setSelfMute(false);
    voice.setSelfDeaf(false);
    await voice.joinVoice(1, 2);
    await flush();
    expect(lk.state.room.options.publishDefaults.audioPreset).toEqual({ maxBitrate: 96000 });

    const mic = lk.state.room.localParticipant.mic;
    sendGuildEvent({ type: 'guild_voice_channel', guildId: 1, channelId: 2, bitrate: 256000, moved: false });
    await flush();
    expect(mic.sender.getParameters().encodings[0].maxBitrate).toBe(256000);
    expect(lk.state.room.options.publishDefaults.audioPreset).toEqual({ maxBitrate: 256000 });
    // Another channel's change isn't ours.
    sendGuildEvent({ type: 'guild_voice_channel', guildId: 1, channelId: 3, bitrate: 8000, moved: false });
    await flush();
    expect(mic.sender.getParameters().encodings[0].maxBitrate).toBe(256000);
  });

  it('joins the channel again (a new token, another server) when it moves to another region', async () => {
    const { fetchVoiceToken } = await import('../services/voiceService');
    await voice.joinVoice(1, 2);
    await flush();
    const before = lk.state.room;
    const asked = fetchVoiceToken.mock.calls.length;
    fetchVoiceToken.mockResolvedValueOnce({ url: 'wss://elsewhere', token: 'token-2', bitrate: 64000 });
    sendGuildEvent({ type: 'guild_voice_channel', guildId: 1, channelId: 2, bitrate: 64000, moved: true });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await flush();
    expect(fetchVoiceToken.mock.calls.length).toBe(asked + 1);
    expect(lk.state.room).not.toBe(before);
    expect(voice.getVoiceSnapshot()).toMatchObject({ status: 'connected', channelId: 2 });
  });
});

describe('voiceClient screen share quality', () => {
  beforeEach(async () => {
    await voice.leaveVoice();
    lk.state.screenShares = [];
  });

  it('shares at this device\'s quality, brought down to the server\'s cap', async () => {
    const { setStreamSettings } = await import('./streamSettings');
    const { fetchVoiceToken } = await import('../services/voiceService');
    fetchVoiceToken.mockResolvedValueOnce({ url: 'wss://lk', token: 'token', streamLimit: { resolution: '1080', frameRate: 30 } });
    lk.state.permissions = { canPublish: true, canPublishSources: [2, 3] };
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    try {
      await voice.joinVoice(1, 2);
      await flush();
      expect(voice.getVoiceSnapshot()).toMatchObject({ canStream: true, streamLimit: { resolution: '1080', frameRate: 30 } });
      setStreamSettings({ resolution: 'source', frameRate: 60 });
      await voice.startScreenShare();
      const [share] = lk.state.screenShares;
      expect(share.capture).toMatchObject({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
        contentHint: 'motion',
      });
      expect(share.publish).toEqual({ screenShareEncoding: { maxBitrate: 4_500_000, maxFramerate: 30 } });
    } finally {
      lk.state.permissions = undefined;
      setStreamSettings({ resolution: '1080', frameRate: 15 });
    }
  });

  it("lists who's in the room, you first, as people come and go", async () => {
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    await voice.joinVoice(1, 2);
    const room = lk.state.room;
    expect(voice.getVoiceSnapshot().participants).toEqual(['1']);
    const participant = {
      identity: '9',
      isMicrophoneEnabled: false,
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublication: () => undefined,
    };
    room.remoteParticipants.set('9', participant);
    room.emit('ParticipantConnected', participant);
    expect(voice.getVoiceSnapshot()).toMatchObject({ participants: ['1', '9'], muted: ['9'] });
    room.remoteParticipants.delete('9');
    room.emit('ParticipantDisconnected', participant);
    expect(voice.getVoiceSnapshot().participants).toEqual(['1']);
    await voice.leaveVoice();
    expect(voice.getVoiceSnapshot().participants).toEqual([]);
  });

  it('says whose stream you watch, and lists the others watching each stream', async () => {
    const { saveWatching } = await import('../services/voiceService');
    saveWatching.mockClear();
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    await voice.joinVoice(1, 2);
    const room = lk.state.room;
    const person = (identity, attributes, sharing = false) => ({
      identity,
      name: `user${identity}`,
      attributes,
      isMicrophoneEnabled: true,
      trackPublications: new Map(),
      audioTrackPublications: new Map(),
      getTrackPublication: (source) => (sharing && source === 'screen_share' ? { source, setSubscribed() {} } : undefined),
    });
    room.remoteParticipants.set('7', person('7', {}, true));
    room.remoteParticipants.set('8', person('8', { watching: '7' }));
    // Watching someone who isn't live, or themselves: not counted.
    room.remoteParticipants.set('9', person('9', { watching: '5' }));
    room.emit('ParticipantConnected', room.remoteParticipants.get('9'));
    expect(voice.getVoiceSnapshot().watchers).toEqual({ 7: [{ id: '8', username: 'user8' }] });
    expect(saveWatching).not.toHaveBeenCalled();

    voice.watchStream('7');
    expect(saveWatching).toHaveBeenLastCalledWith(7);
    room.remoteParticipants.get('9').attributes = { watching: '7' };
    room.emit('ParticipantAttributesChanged', {}, room.remoteParticipants.get('9'));
    expect(voice.getVoiceSnapshot().watchers[7].map((w) => w.id)).toEqual(['8', '9']);

    voice.watchStream(null);
    expect(saveWatching).toHaveBeenLastCalledWith(null);
    expect(saveWatching).toHaveBeenCalledTimes(2);
    await voice.leaveVoice();
    expect(voice.getVoiceSnapshot().watchers).toEqual({});
  });
});

describe('voiceClient camera', () => {
  beforeEach(async () => {
    await voice.leaveVoice();
    lk.state.cameraFails = false;
  });

  async function joinWithCamera() {
    lk.state.permissions = { canPublish: true, canPublishSources: [1, 2] };
    lk.state.capture = lk.deferred();
    lk.state.capture.resolve();
    try {
      await voice.joinVoice(1, 2);
    } finally {
      lk.state.permissions = undefined;
    }
    await voice.startCamera();
    expect(voice.getVoiceSnapshot()).toMatchObject({ cameraOn: true, cameraFacing: null });
    return lk.state.room.localParticipant;
  }

  it("switches a phone's camera between front and back, and keeps the choice until leaving", async () => {
    const me = await joinWithCamera();
    const camera = me.camera;
    await voice.switchCamera();
    expect(camera.restarts.at(-1)).toMatchObject({ facingMode: 'environment' });
    expect(voice.getVoiceSnapshot().cameraFacing).toBe('environment');
    await voice.switchCamera();
    expect(camera.restarts.at(-1)).toMatchObject({ facingMode: 'user' });
    await voice.switchCamera();
    // The same track throughout (not published again), and back on the same camera next time.
    expect(me.camera).toBe(camera);
    await voice.stopCamera();
    await voice.startCamera();
    expect(me.camera.options).toMatchObject({ facingMode: 'environment' });
    await voice.leaveVoice();
    expect(voice.getVoiceSnapshot().cameraFacing).toBe(null);
    const again = await joinWithCamera();
    expect(again.camera.options).toMatchObject({ facingMode: 'user' });
  });

  it('goes back to the camera it had when the other one fails', async () => {
    const me = await joinWithCamera();
    lk.state.cameraFails = true;
    await voice.switchCamera();
    expect(voice.getVoiceSnapshot()).toMatchObject({ cameraFacing: null, cameraError: expect.any(String) });
    expect(me.camera.restarts.map((o) => o.facingMode)).toEqual(['environment', 'user']);
  });
});
