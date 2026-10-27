import { useSyncExternalStore } from 'react';
import { getAudioSettings, onAudioSettingsChange } from './audioSettings';
import { buttonOfEvent, keyOfEvent } from './pushToTalkKeys';

// Push to talk (Settings → Voice & video, Input mode), like Discord's: the microphone is only
// sent while the chosen key or mouse button is held, and for the release delay after it's let
// go (so the last word isn't cut off). In the page the key works while Voicaw has focus
// (startPushToTalkKeys); the desktop app also hears it while another app has focus, through a
// keyboard hook (electron/pushToTalk.js, hooks/useDesktopApp.js); and the hold button in the
// voice bar and the call view (PushToTalkButton) works with a finger or the mouse.
//
// Each of those is a `source`: talking lasts while any of them is held, so letting go of the
// key while the button is still pressed doesn't stop it. What's sent is cut by a gain at the
// end of the microphone chain (pushToTalkStage), not by muting: that's instant, and the
// microphone stays captured, so the first word isn't lost to starting it. Mute and deafen
// still win (voiceClient turns the microphone off for them).

const OPEN_SECONDS = 0.005; // the gain's ramps (no clicks); linear, so closed is exactly 0
const CLOSE_SECONDS = 0.015;

const held = new Set();
let pressed = false; // held, or within the release delay
let releaseTimer = null;
const listeners = new Set();

const isOn = (s = getAudioSettings()) => s.inputMode === 'pushToTalk';

// Whether the microphone may be sent now, as far as push to talk goes (always, with voice
// activity).
export const isSending = (s = getAudioSettings()) => !isOn(s) || pressed;

// Whether the desktop app hears the key in other apps: 'on', 'failed' (the system wouldn't
// let it: macOS without Accessibility, no X11), or null (not asked: not in voice, or a browser).
let outside = null;

// { on: push to talk is the input mode, pressed: talking now, outside }.
let state = { on: isOn(), pressed, outside };
const getState = () => state;

export function onPushToTalkChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const usePushToTalk = () => useSyncExternalStore(onPushToTalkChange, getState);

function changed() {
  const next = { on: isOn(), pressed, outside };
  if (next.on === state.on && next.pressed === state.pressed && next.outside === state.outside) return;
  const previous = state;
  state = next;
  applyGains();
  for (const listener of listeners) listener(state, previous);
}

export function pushToTalkDown(source) {
  held.add(source);
  clearTimeout(releaseTimer);
  releaseTimer = null;
  pressed = true;
  changed();
}

export function pushToTalkUp(source) {
  if (!held.delete(source) || held.size > 0) return;
  clearTimeout(releaseTimer);
  const delay = getAudioSettings().pushToTalkDelay;
  const release = () => {
    releaseTimer = null;
    pressed = false;
    changed();
  };
  if (delay > 0) releaseTimer = setTimeout(release, delay);
  else release();
}

// A voice chain stage (voiceChain.js), last: silent unless sending.
const gains = new Set();

function applyGains() {
  const sending = isSending();
  for (const gain of gains) {
    const { currentTime } = gain.context;
    const param = gain.gain;
    param.cancelScheduledValues(currentTime);
    param.setValueAtTime(param.value, currentTime);
    param.linearRampToValueAtTime(sending ? 1 : 0, currentTime + (sending ? OPEN_SECONDS : CLOSE_SECONDS));
  }
}

export function pushToTalkStage(context) {
  const gain = context.createGain();
  gain.gain.value = isSending() ? 1 : 0;
  gains.add(gain);
  return { input: gain, output: gain, destroy: () => gains.delete(gain) };
}

onAudioSettingsChange((next, previous) => {
  if (next.pushToTalkKey !== previous.pushToTalkKey) {
    held.delete('key');
    if (!held.size) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
      pressed = false;
    }
  }
  changed();
});

export function setOutsidePushToTalk(value) {
  outside = value;
  changed();
}

// While Settings records a new key, the old one doesn't talk.
let recording = false;
export function setRecordingPushToTalkKey(on) {
  recording = on;
  if (on) pushToTalkUp('key');
}

// The key (or mouse button) in this page, while it has focus: listened for from the start, and
// acted on only with push to talk on. Typing it in a text box still types it (as Discord's).
// Letting go elsewhere isn't seen, so the page losing focus lets go.
let listening = false;
export function startPushToTalkKeys(target = typeof window !== 'undefined' ? window : null) {
  if (listening || !target) return;
  listening = true;
  const matches = (key) => !recording && isOn() && key && key === getAudioSettings().pushToTalkKey;
  target.addEventListener('keydown', (e) => {
    if (matches(keyOfEvent(e))) pushToTalkDown('key');
  }, true);
  target.addEventListener('keyup', (e) => {
    if (keyOfEvent(e) === getAudioSettings().pushToTalkKey) pushToTalkUp('key');
  }, true);
  target.addEventListener('mousedown', (e) => {
    if (matches(buttonOfEvent(e))) pushToTalkDown('key');
  }, true);
  target.addEventListener('mouseup', (e) => {
    const button = buttonOfEvent(e);
    if (button !== getAudioSettings().pushToTalkKey) return;
    pushToTalkUp('key');
    // The back and forward buttons would go back and forward in the app as well.
    if (isOn()) e.preventDefault();
  }, true);
  target.addEventListener('blur', () => pushToTalkUp('key'));
}

// For tests.
export function resetPushToTalk() {
  held.clear();
  clearTimeout(releaseTimer);
  releaseTimer = null;
  pressed = false;
  recording = false;
  outside = null;
  changed();
}
