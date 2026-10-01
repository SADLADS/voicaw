// Every sound the app plays: Discord's set, for the things Voicaw has. Each is drawn with Web
// Audio oscillators (`tone`) unless it has a `file` (a path under client/public, e.g.
// '/sounds/message.ogg'): then that's played, and the tone only if the file can't be loaded.
//
// tone: { notes: [[start s, frequency Hz, length s], ...], volume (0-1, before the user's
//   volume), wave ('sine' default, 'triangle'...), shape ('bell': struck and fading, the
//   default; 'flat': held, for rings) }.
// every: ms between repeats when it's played as a loop (rings).
// minGap: ms during which the same sound isn't played again (a burst of messages dings once).

export const SOUNDS = {
  message: {
    label: 'Message',
    description: 'A message you’d be notified about arrives (DMs, group DMs, guild mentions)',
    tone: { notes: [[0, 1046.5, 0.12], [0.08, 1568, 0.3]], volume: 0.12 },
    minGap: 1000,
  },
  mute: {
    label: 'Mute',
    tone: { notes: [[0, 784, 0.09], [0.07, 523.3, 0.16]], volume: 0.12, wave: 'triangle' },
  },
  unmute: {
    label: 'Unmute',
    tone: { notes: [[0, 523.3, 0.09], [0.07, 784, 0.16]], volume: 0.12, wave: 'triangle' },
  },
  deafen: {
    label: 'Deafen',
    tone: { notes: [[0, 659.3, 0.08], [0.07, 493.9, 0.08], [0.14, 329.6, 0.2]], volume: 0.12, wave: 'triangle' },
  },
  undeafen: {
    label: 'Undeafen',
    tone: { notes: [[0, 329.6, 0.08], [0.07, 493.9, 0.08], [0.14, 659.3, 0.2]], volume: 0.12, wave: 'triangle' },
  },
  userJoin: {
    label: 'User join',
    description: 'You or someone else joins your voice channel or call',
    tone: { notes: [[0, 587.3, 0.18], [0.1, 880, 0.35]], volume: 0.14 },
  },
  userLeave: {
    label: 'User leave',
    description: 'Someone leaves your voice channel or call',
    tone: { notes: [[0, 880, 0.18], [0.1, 587.3, 0.35]], volume: 0.14 },
  },
  disconnect: {
    label: 'Voice disconnected',
    description: 'You leave voice, a call ends, or the connection is lost',
    tone: { notes: [[0, 659.3, 0.14], [0.1, 440, 0.14], [0.2, 293.7, 0.4]], volume: 0.14 },
  },
  incomingRing: {
    label: 'Incoming ring',
    description: 'Someone is calling you',
    // Two rising notes, twice, every 3 s.
    tone: { notes: [[0, 660, 0.15], [0.18, 880, 0.15], [0.45, 660, 0.15], [0.63, 880, 0.2]], volume: 0.18, shape: 'flat' },
    every: 3000,
  },
  outgoingRing: {
    label: 'Outgoing ring',
    description: 'Your call is ringing',
    // A soft 440+480 Hz tone for 1.5 s, every 4 s (the usual ringback).
    tone: { notes: [[0, 440, 1.5], [0, 480, 1.5]], volume: 0.05, shape: 'flat' },
    every: 4000,
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);
