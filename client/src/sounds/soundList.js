// Every sound the app plays: Discord's set, for the things Voicaw has. Each is drawn with Web
// Audio oscillators (`tone`) unless it has a `file` (a path under client/public, e.g.
// '/sounds/message.ogg'): then that's played, and the tone only if the file can't be loaded.
//
// tone: { notes: [[start s, frequency Hz, length s], ...], volume (0-1, before the user's
//   volume), wave ('sine' default, 'triangle'...), shape ('bell': struck and fading, the
//   default; 'flat': held, for rings), detune (cents: two oscillators per note, pulled apart),
//   filter ({ from, to, length, q }: a lowpass closing from `from` to `to` Hz) }.
// fileVolume: 0-1, the `file`'s level before the user's volume (a file at full scale is far
//   louder than the tones).
// every: ms between repeats when it's played as a loop (rings).
// minGap: ms during which the same sound isn't played again (a burst of messages dings once).

// labelKey / descriptionKey: the text Settings → Sounds shows (i18n keys).
export const SOUNDS = {
  message: {
    labelKey: 'settings.sounds.message.label',
    descriptionKey: 'settings.sounds.message.description',
    tone: { notes: [[0, 1046.5, 0.12], [0.08, 1568, 0.3]], volume: 0.12 },
    minGap: 1000,
  },
  mute: {
    labelKey: 'settings.sounds.mute.label',
    tone: { notes: [[0, 784, 0.09], [0.07, 523.3, 0.16]], volume: 0.12, wave: 'triangle' },
  },
  unmute: {
    labelKey: 'settings.sounds.unmute.label',
    tone: { notes: [[0, 523.3, 0.09], [0.07, 784, 0.16]], volume: 0.12, wave: 'triangle' },
  },
  deafen: {
    labelKey: 'settings.sounds.deafen.label',
    tone: { notes: [[0, 659.3, 0.08], [0.07, 493.9, 0.08], [0.14, 329.6, 0.2]], volume: 0.12, wave: 'triangle' },
  },
  undeafen: {
    labelKey: 'settings.sounds.undeafen.label',
    tone: { notes: [[0, 329.6, 0.08], [0.07, 493.9, 0.08], [0.14, 659.3, 0.2]], volume: 0.12, wave: 'triangle' },
  },
  userJoin: {
    labelKey: 'settings.sounds.userJoin.label',
    descriptionKey: 'settings.sounds.userJoin.description',
    tone: { notes: [[0, 587.3, 0.18], [0.1, 880, 0.35]], volume: 0.14 },
  },
  userLeave: {
    labelKey: 'settings.sounds.userLeave.label',
    descriptionKey: 'settings.sounds.userLeave.description',
    tone: { notes: [[0, 880, 0.18], [0.1, 587.3, 0.35]], volume: 0.14 },
  },
  disconnect: {
    labelKey: 'settings.sounds.disconnect.label',
    descriptionKey: 'settings.sounds.disconnect.description',
    tone: { notes: [[0, 659.3, 0.14], [0.1, 440, 0.14], [0.2, 293.7, 0.4]], volume: 0.14 },
  },
  incomingRing: {
    labelKey: 'settings.sounds.incomingRing.label',
    descriptionKey: 'settings.sounds.incomingRing.description',
    // Two rising notes, twice, every 3 s.
    tone: { notes: [[0, 660, 0.15], [0.18, 880, 0.15], [0.45, 660, 0.15], [0.63, 880, 0.2]], volume: 0.18, shape: 'flat' },
    every: 3000,
  },
  outgoingRing: {
    labelKey: 'settings.sounds.outgoingRing.label',
    descriptionKey: 'settings.sounds.outgoingRing.description',
    // A soft 440+480 Hz tone for 1.5 s, every 4 s (the usual ringback).
    tone: { notes: [[0, 440, 1.5], [0, 480, 1.5]], volume: 0.05, shape: 'flat' },
    every: 4000,
  },
  logo: {
    labelKey: 'settings.sounds.logo.label',
    descriptionKey: 'settings.sounds.logo.description',
    // A Philly hit (the 80s orchestra stab). The file peaks near full scale, so it's turned down
    // to the tones' level. If it can't load: a big C major chord of detuned saws, struck all at
    // once, through a lowpass closing fast. Every click on the bird while on the DM side plays,
    // however quick.
    file: '/sounds/hit.mp3',
    fileVolume: 0.3,
    tone: {
      notes: [65.41, 130.81, 196, 261.63, 329.63, 392, 523.25].map((frequency) => [0, frequency, 0.9]),
      volume: 0.035,
      wave: 'sawtooth',
      detune: 10,
      filter: { from: 7000, to: 700, length: 0.5, q: 2 },
    },
    minGap: 0,
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);
