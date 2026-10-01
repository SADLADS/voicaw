import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  canChooseOutput, listAudioDevices, onDeviceChange, resetAudioSettings, setAudioSettings, useAudioSettings,
} from '../voice/audioSettings';
import { startMicTest } from '../voice/micTest';
import { ALWAYS_OPEN_DB } from '../voice/noise/gate';
import {
  canSuppressNoise, canSuppressStrongly, isDeepFilterSlow, onDeepFilterSlow,
} from '../voice/noise/noiseStages';

const PROCESSING = [
  ['echoCancellation', 'Echo cancellation', 'Stops others hearing themselves through your speakers.'],
  ['autoGainControl', 'Automatic gain control', 'Evens out your volume when you move closer or further away.'],
];

const NOISE_MODES = [
  ['standard', 'Standard', 'Removes background noise like fans, traffic and typing. Light on your device.'],
  ['strong', 'Strong', 'Removes more, even while you talk, using more of your computer. A 17 MB download the first time.'],
  ['browser', "Your browser's", 'Good for steady noise like fans; lets typing through.'],
  ['off', 'Off', 'Your microphone as it is.'],
];

// The sensitivity meter's scale, in dB (the slider's range).
const meterShare = (db) => Math.min(1, Math.max(0, (db - ALWAYS_OPEN_DB) / -ALWAYS_OPEN_DB));

function micTestError(err) {
  if (err?.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it to test.';
  if (err?.name === 'NotFoundError') return 'No microphone found.';
  return 'Could not use the microphone.';
}

// Settings → Voice & video: microphone and speakers on this device (voice/audioSettings.js),
// a microphone test, and the browser's voice processing. Changes apply to a call at once.
// (Video settings go here too, once there's video.)
export default function VoiceSettings() {
  const settings = useAudioSettings();
  const [devices, setDevices] = useState({ inputs: [], outputs: [], labelled: true, defaults: {} });
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [testError, setTestError] = useState(null);
  const [gate, setGate] = useState(null); // { db, open } while testing
  const stopTest = useRef(null);
  const strongSlow = useSyncExternalStore(onDeepFilterSlow, isDeepFilterSlow);
  const suppressionAvailable = canSuppressNoise();
  const strongAvailable = canSuppressStrongly();

  const refreshDevices = useCallback(() => {
    listAudioDevices().then(setDevices).catch(() => {});
  }, []);

  useEffect(() => {
    refreshDevices();
    return onDeviceChange(refreshDevices);
  }, [refreshDevices]);

  // Browsers only name devices once the page may use the microphone.
  const allowMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (err) {
      setTestError(micTestError(err));
    }
    refreshDevices();
  };

  // The test runs with the chosen microphone and processing; changing those restarts it.
  const { inputDeviceId, echoCancellation, noiseSuppression, autoGainControl } = settings;
  useEffect(() => {
    if (!testing) return undefined;
    let cancelled = false;
    setTestError(null);
    startMicTest({ onLevel: setLevel, onGate: (db, open) => setGate({ db, open }) })
      .then((stop) => {
        if (cancelled) stop();
        else stopTest.current = stop;
        refreshDevices();
      })
      .catch((err) => {
        if (cancelled) return;
        setTestError(micTestError(err));
        setTesting(false);
      });
    return () => {
      cancelled = true;
      stopTest.current?.();
      stopTest.current = null;
      setGate(null);
    };
  }, [testing, inputDeviceId, echoCancellation, noiseSuppression, autoGainControl, refreshDevices]);

  const chooseOutput = canChooseOutput();
  const defaultLabel = (name) => (name ? `Default (${name})` : 'Default');
  const missing = (list, id) => id && !list.some((d) => d.id === id);

  return (
    <div className="settings-card voice-settings">
      <h5>Voice</h5>
      <div className="voice-settings-grid">
        <label className="voice-settings-field">
          <span>Input device</span>
          <select
            aria-label="Input device"
            value={settings.inputDeviceId}
            onChange={(e) => setAudioSettings({ inputDeviceId: e.target.value })}
          >
            <option value="">{defaultLabel(devices.defaults.input)}</option>
            {devices.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            {missing(devices.inputs, settings.inputDeviceId) && (
              <option value={settings.inputDeviceId}>Not connected</option>
            )}
          </select>
        </label>
        {chooseOutput && (
          <label className="voice-settings-field">
            <span>Output device</span>
            <select
              aria-label="Output device"
              value={settings.outputDeviceId}
              onChange={(e) => setAudioSettings({ outputDeviceId: e.target.value })}
            >
              <option value="">{defaultLabel(devices.defaults.output)}</option>
              {devices.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              {missing(devices.outputs, settings.outputDeviceId) && (
                <option value={settings.outputDeviceId}>Not connected</option>
              )}
            </select>
          </label>
        )}
        <label className="voice-settings-field">
          <span>Input volume</span>
          <span className="sound-volume">
            <input
              type="range" min="0" max="200" step="1"
              aria-label="Input volume"
              value={Math.round(settings.inputVolume * 100)}
              onChange={(e) => setAudioSettings({ inputVolume: Number(e.target.value) / 100 })}
            />
            <span className="sound-volume-value">{Math.round(settings.inputVolume * 100)}%</span>
          </span>
        </label>
        <label className="voice-settings-field">
          <span>Output volume</span>
          <span className="sound-volume">
            <input
              type="range" min="0" max="100" step="1"
              aria-label="Output volume"
              value={Math.round(settings.outputVolume * 100)}
              onChange={(e) => setAudioSettings({ outputVolume: Number(e.target.value) / 100 })}
            />
            <span className="sound-volume-value">{Math.round(settings.outputVolume * 100)}%</span>
          </span>
        </label>
      </div>
      {!devices.labelled && (
        <p className="vc-hint">
          Your browser hides device names until Voicaw may use the microphone.{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={allowMicrophone}>Allow it</button>
        </p>
      )}

      <h6 className="voice-settings-heading">Mic test</h6>
      <p className="vc-hint">Talk and you&apos;ll hear yourself back, as others hear you. Headphones help.</p>
      <div className="mic-test">
        <button
          type="button"
          className={`btn btn-sm ${testing ? 'btn-secondary' : 'btn-primary vc-button'}`}
          onClick={() => setTesting((t) => !t)}
        >
          {testing ? 'Stop testing' : "Let's check"}
        </button>
        <div
          className="mic-test-meter"
          role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div className="mic-test-level" style={{ transform: `scaleX(${level})` }} />
        </div>
      </div>
      {testError && <p className="error-text">{testError}</p>}

      <h6 className="voice-settings-heading">Noise suppression</h6>
      <div role="radiogroup" aria-label="Noise suppression">
        {NOISE_MODES.map(([mode, label, hint]) => {
          const unavailable = (mode === 'standard' && !suppressionAvailable)
            || (mode === 'strong' && !strongAvailable);
          return (
            <label key={mode} className={`settings-toggle voice-settings-toggle${unavailable ? ' disabled' : ''}`}>
              <input
                type="radio" name="noise-suppression" value={mode}
                checked={settings.noiseSuppression === mode}
                disabled={unavailable}
                onChange={() => setAudioSettings({ noiseSuppression: mode })}
              />
              <span>
                {label}
                <span className="vc-hint">
                  {mode === 'strong' && !strongAvailable ? 'Only on computers, in an up-to-date browser.' : hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {settings.noiseSuppression === 'strong' && strongSlow && (
        <p className="error-text">This computer can&apos;t keep up with Strong, so Standard is being used instead.</p>
      )}

      <h6 className="voice-settings-heading">Input sensitivity</h6>
      <label className="settings-toggle voice-settings-toggle">
        <input
          type="checkbox" checked={settings.autoSensitivity}
          onChange={(e) => setAudioSettings({ autoSensitivity: e.target.checked })}
        />
        <span>
          Automatic
          <span className="vc-hint">
            Sends your voice only while you talk, so typing and clicks in between aren&apos;t heard.
          </span>
        </span>
      </label>
      {!settings.autoSensitivity && (
        <div className="voice-sensitivity">
          <input
            type="range" min={ALWAYS_OPEN_DB} max="0" step="1"
            aria-label="Input sensitivity"
            value={settings.sensitivity}
            onChange={(e) => setAudioSettings({ sensitivity: Number(e.target.value) })}
          />
          <div
            className="voice-sensitivity-meter"
            role="meter" aria-label="Level against input sensitivity" aria-valuemin={ALWAYS_OPEN_DB} aria-valuemax={0}
            aria-valuenow={gate ? Math.round(gate.db) : ALWAYS_OPEN_DB}
          >
            <div
              className={`voice-sensitivity-level${gate?.open ? ' open' : ''}`}
              style={{ transform: `scaleX(${gate ? meterShare(gate.db) : 0})` }}
            />
            <div className="voice-sensitivity-mark" style={{ left: `${meterShare(settings.sensitivity) * 100}%` }} />
          </div>
          <p className="vc-hint">
            {settings.sensitivity <= ALWAYS_OPEN_DB
              ? 'Always sending.'
              : `Sends sound louder than ${settings.sensitivity} dB.`}
            {!testing && " Use Let's check to see your level against it."}
          </p>
        </div>
      )}

      <h6 className="voice-settings-heading">Voice processing</h6>
      {PROCESSING.map(([key, label, hint]) => (
        <label key={key} className="settings-toggle voice-settings-toggle">
          <input type="checkbox" checked={settings[key]} onChange={(e) => setAudioSettings({ [key]: e.target.checked })} />
          <span>
            {label}
            <span className="vc-hint">{hint}</span>
          </span>
        </label>
      ))}
      <div className="voice-settings-footer">
        <span className="vc-hint">Saved on this device.</span>
        <button type="button" className="btn btn-link btn-sm" onClick={resetAudioSettings}>Reset voice settings</button>
      </div>
    </div>
  );
}
