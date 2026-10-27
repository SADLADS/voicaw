import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetAudioSettings, setAudioSettings } from './audioSettings';
import {
  isSending, onPushToTalkChange, pushToTalkDown, pushToTalkStage, pushToTalkUp, resetPushToTalk,
  setRecordingPushToTalkKey, startPushToTalkKeys,
} from './pushToTalk';
import {
  buttonOfEvent, describePushToTalkKey, isPushToTalkKey, keyOfEvent, NAMED_KEYS, PUSH_TO_TALK_KEYS,
} from './pushToTalkKeys';
import i18n from '../i18n';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});

// A GainNode as far as the stage uses one: where its ramps are heading.
function fakeContext() {
  return {
    currentTime: 1,
    createGain() {
      const gain = { value: 1, target: null };
      gain.cancelScheduledValues = () => {};
      gain.setValueAtTime = () => {};
      gain.linearRampToValueAtTime = (value) => { gain.target = value; };
      return { gain, context: this };
    },
  };
}

// An EventTarget standing in for the window.
function fakeWindow() {
  const target = new EventTarget();
  const fire = (type, init) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, init);
    target.dispatchEvent(e);
    return e;
  };
  return { target, fire };
}

describe('push to talk (pushToTalk.js)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAudioSettings();
    resetPushToTalk();
  });
  afterEach(() => vi.useRealTimers());

  it('always sends with voice activity, only while held with push to talk', () => {
    expect(isSending()).toBe(true);
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    expect(isSending()).toBe(false);
    pushToTalkDown('key');
    expect(isSending()).toBe(true);
    pushToTalkUp('key');
    expect(isSending()).toBe(false);
  });

  it('keeps sending for the release delay, and a new press inside it carries on', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 300 });
    pushToTalkDown('key');
    pushToTalkUp('key');
    vi.advanceTimersByTime(200);
    expect(isSending()).toBe(true);
    pushToTalkDown('key');
    vi.advanceTimersByTime(500);
    expect(isSending()).toBe(true);
    pushToTalkUp('key');
    vi.advanceTimersByTime(299);
    expect(isSending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSending()).toBe(false);
  });

  it('talks while any source is held', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    pushToTalkDown('key');
    pushToTalkDown('button');
    pushToTalkUp('key');
    expect(isSending()).toBe(true);
    pushToTalkUp('key'); // already up: nothing
    expect(isSending()).toBe(true);
    pushToTalkUp('button');
    expect(isSending()).toBe(false);
  });

  it('silences the chain stage until held, and opens it with voice activity again', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    const stage = pushToTalkStage(fakeContext());
    expect(stage.input).toBe(stage.output);
    expect(stage.output.gain.value).toBe(0);
    pushToTalkDown('key');
    expect(stage.output.gain.target).toBe(1);
    pushToTalkUp('key');
    expect(stage.output.gain.target).toBe(0);
    setAudioSettings({ inputMode: 'voice' });
    expect(stage.output.gain.target).toBe(1);
    stage.destroy();
    setAudioSettings({ inputMode: 'pushToTalk' });
    expect(stage.output.gain.target).toBe(1); // no longer kept up to date
  });

  it('starts a stage built while held open', () => {
    setAudioSettings({ inputMode: 'pushToTalk' });
    pushToTalkDown('key');
    expect(pushToTalkStage(fakeContext()).output.gain.value).toBe(1);
  });

  it('tells listeners when talking starts and stops', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    const seen = [];
    const stop = onPushToTalkChange((next) => seen.push(next.pressed));
    pushToTalkDown('key');
    pushToTalkDown('key'); // a key repeating
    pushToTalkUp('key');
    stop();
    expect(seen).toEqual([true, false]);
  });

  it('follows the chosen key and mouse button in the page, only with push to talk on', () => {
    const { target, fire } = fakeWindow();
    startPushToTalkKeys(target);
    setAudioSettings({ pushToTalkKey: 'Backquote', pushToTalkDelay: 0 });
    fire('keydown', { code: 'Backquote' });
    expect(isSending()).toBe(true); // voice activity: always
    setAudioSettings({ inputMode: 'pushToTalk' });
    fire('keydown', { code: 'KeyV' });
    expect(isSending()).toBe(false);
    fire('keydown', { code: 'Backquote' });
    expect(isSending()).toBe(true);
    fire('keyup', { code: 'Backquote' });
    expect(isSending()).toBe(false);

    // Losing focus lets go (the key's release won't be seen).
    fire('keydown', { code: 'Backquote' });
    fire('blur');
    expect(isSending()).toBe(false);

    setAudioSettings({ pushToTalkKey: 'Mouse4' });
    fire('mousedown', { button: 3 });
    expect(isSending()).toBe(true);
    const up = fire('mouseup', { button: 3 });
    expect(isSending()).toBe(false);
    expect(up.defaultPrevented).toBe(true); // no going back in the app

    // While Settings records a new key, the old one does nothing.
    setRecordingPushToTalkKey(true);
    fire('mousedown', { button: 3 });
    expect(isSending()).toBe(false);
    setRecordingPushToTalkKey(false);
  });

  it('lets go when the key changes', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkKey: 'KeyV', pushToTalkDelay: 1000 });
    pushToTalkDown('key');
    setAudioSettings({ pushToTalkKey: 'KeyB' });
    expect(isSending()).toBe(false);
  });
});

describe('push to talk keys (pushToTalkKeys.js)', () => {
  it('takes keys and side buttons, not ones the app needs', () => {
    for (const key of ['KeyV', 'Digit1', 'F13', 'Numpad4', 'Backquote', 'ControlLeft', 'CapsLock', 'Space', 'Mouse5']) {
      expect(isPushToTalkKey(key), key).toBe(true);
    }
    for (const key of ['Escape', 'Backspace', 'Enter', 'Tab', 'Mouse1', '', null, 'KeyÅ']) {
      expect(isPushToTalkKey(key), key).toBe(false);
    }
    expect(keyOfEvent({ code: 'KeyV' })).toBe('KeyV');
    expect(keyOfEvent({ code: 'Escape' })).toBe(null);
    expect([0, 1, 2, 3, 4].map((button) => buttonOfEvent({ button }))).toEqual([null, 'Mouse3', null, 'Mouse4', 'Mouse5']);
  });

  it('has the same keys as the desktop app\'s hook', () => {
    const { PUSH_TO_TALK_KEYS: desktopKeys } = require('../../../electron/pushToTalk.js');
    expect([...desktopKeys].sort()).toEqual([...PUSH_TO_TALK_KEYS].sort());
  });

  it('names every key', () => {
    expect(describePushToTalkKey('KeyV')).toBe('V');
    expect(describePushToTalkKey('Digit7')).toBe('7');
    expect(describePushToTalkKey('F13')).toBe('F13');
    expect(describePushToTalkKey('Backquote')).toBe('`');
    expect(describePushToTalkKey('Numpad4')).toBe('Numpad 4');
    expect(describePushToTalkKey('NumpadAdd')).toBe('Numpad +');
    expect(describePushToTalkKey('ControlLeft', 'Win32')).toBe('Left Ctrl');
    expect(describePushToTalkKey('MetaLeft', 'Win32')).toBe('Left Windows');
    expect(describePushToTalkKey('MetaLeft', 'MacIntel')).toBe('Left Command');
    expect(describePushToTalkKey('AltRight', 'darwin')).toBe('Right Option');
    expect(describePushToTalkKey('MetaRight', 'Linux x86_64')).toBe('Right Super');
    expect(describePushToTalkKey('Mouse4')).toBe('Mouse back button');
    expect(describePushToTalkKey('Escape')).toBe('');
    for (const key of NAMED_KEYS) expect(i18n.exists(`settings.voice.pushToTalk.keys.${key}`), key).toBe(true);
  });
});
