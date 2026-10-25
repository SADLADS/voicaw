import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  canChooseInput, canChooseOutput, listAudioDevices, onDeviceChange, resetAudioSettings, setAudioSettings, useAudioSettings,
} from '../voice/audioSettings';
import { startMicTest } from '../voice/micTest';
import { canShareScreen, setMicTesting } from '../voice/voiceClient';
import CameraSettings from './CameraSettings';
import StreamQualityPicker from './voice/StreamQualityPicker';
import { ALWAYS_OPEN_DB } from '../voice/noise/gate';
import {
  canSuppressNoise, canSuppressStrongly, isDeepFilterSlow, onDeepFilterSlow,
} from '../voice/noise/noiseStages';
import { t } from '../i18n';

// [setting, label key, hint key]
const PROCESSING = [
  ['echoCancellation', 'settings.voice.echoCancellation.label', 'settings.voice.echoCancellation.hint'],
  ['autoGainControl', 'settings.voice.autoGainControl.label', 'settings.voice.autoGainControl.hint'],
];

// Soundboards (voice/soundboard.js): [on, volume, translation key].
const SOUNDBOARD = [
  ['soundboardOn', 'soundboardVolume', 'sounds'],
  ['joinSoundsOn', 'joinSoundVolume', 'join'],
];

const NOISE_MODES = [
  ['standard', 'settings.voice.noise.standard.label', 'settings.voice.noise.standard.hint'],
  ['strong', 'settings.voice.noise.strong.label', 'settings.voice.noise.strong.hint'],
  ['browser', 'settings.voice.noise.browser.label', 'settings.voice.noise.browser.hint'],
  ['off', 'settings.voice.noise.off.label', 'settings.voice.noise.off.hint'],
];

// The sensitivity meter's scale, in dB (the slider's range).
const meterShare = (db) => Math.min(1, Math.max(0, (db - ALWAYS_OPEN_DB) / -ALWAYS_OPEN_DB));

function micTestError(err) {
  if (err?.name === 'NotAllowedError') return t('settings.voice.micBlocked');
  if (err?.name === 'NotFoundError') return t('settings.voice.noMic');
  return t('settings.voice.micFailed');
}

// Settings → Voice & video: microphone (not on phones and tablets) and speakers (where the
// browser can choose) on this device (voice/audioSettings.js),
// a microphone test, the browser's voice processing, and the camera (CameraSettings). Changes
// apply to a call at once.
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

  // Testing mutes and deafens you (in a call too) until it stops; a restart below doesn't
  // let go in between.
  useEffect(() => {
    if (!testing) return undefined;
    setMicTesting(true);
    return () => setMicTesting(false);
  }, [testing]);

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

  const chooseInput = canChooseInput();
  const chooseOutput = canChooseOutput();
  const defaultLabel = (name) => (name ? t('settings.voice.defaultDeviceNamed', { name }) : t('settings.voice.defaultDevice'));
  const missing = (list, id) => id && !list.some((d) => d.id === id);

  return (
    <div className="settings-card voice-settings">
      <h5 id="settings-voice">{t('settings.voice.title')}</h5>
      <div className="voice-settings-grid">
        {chooseInput && (
          <label className="voice-settings-field">
            <span>{t('settings.voice.inputDevice')}</span>
            <select
              aria-label={t('settings.voice.inputDevice')}
              value={settings.inputDeviceId}
              onChange={(e) => setAudioSettings({ inputDeviceId: e.target.value })}
            >
              <option value="">{defaultLabel(devices.defaults.input)}</option>
              {devices.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              {missing(devices.inputs, settings.inputDeviceId) && (
                <option value={settings.inputDeviceId}>{t('settings.voice.notConnected')}</option>
              )}
            </select>
          </label>
        )}
        {chooseOutput && (
          <label className="voice-settings-field">
            <span>{t('settings.voice.outputDevice')}</span>
            <select
              aria-label={t('settings.voice.outputDevice')}
              value={settings.outputDeviceId}
              onChange={(e) => setAudioSettings({ outputDeviceId: e.target.value })}
            >
              <option value="">{defaultLabel(devices.defaults.output)}</option>
              {devices.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              {missing(devices.outputs, settings.outputDeviceId) && (
                <option value={settings.outputDeviceId}>{t('settings.voice.notConnected')}</option>
              )}
            </select>
          </label>
        )}
        <label className="voice-settings-field">
          <span>{t('settings.voice.inputVolume')}</span>
          <span className="sound-volume">
            <input
              type="range" min="0" max="200" step="1"
              aria-label={t('settings.voice.inputVolume')}
              value={Math.round(settings.inputVolume * 100)}
              onChange={(e) => setAudioSettings({ inputVolume: Number(e.target.value) / 100 })}
            />
            <span className="sound-volume-value">{Math.round(settings.inputVolume * 100)}%</span>
          </span>
        </label>
        <label className="voice-settings-field">
          <span>{t('settings.voice.outputVolume')}</span>
          <span className="sound-volume">
            <input
              type="range" min="0" max="100" step="1"
              aria-label={t('settings.voice.outputVolume')}
              value={Math.round(settings.outputVolume * 100)}
              onChange={(e) => setAudioSettings({ outputVolume: Number(e.target.value) / 100 })}
            />
            <span className="sound-volume-value">{Math.round(settings.outputVolume * 100)}%</span>
          </span>
        </label>
      </div>
      {!devices.labelled && (chooseInput || chooseOutput) && (
        <p className="vc-hint">
          {t('settings.voice.namesHidden')}{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={allowMicrophone}>{t('settings.voice.allowIt')}</button>
        </p>
      )}

      <h6 id="settings-mic-test" className="voice-settings-heading">{t('settings.voice.micTest')}</h6>
      <p className="vc-hint">{t('settings.voice.micTestHint')}</p>
      <div className="mic-test">
        <button
          type="button"
          className={`btn btn-sm ${testing ? 'btn-secondary' : 'btn-primary vc-button'}`}
          onClick={() => setTesting((on) => !on)}
        >
          {testing ? t('settings.voice.stopTesting') : t('settings.voice.letsCheck')}
        </button>
        <div
          className="mic-test-meter"
          role="meter" aria-label={t('settings.voice.micLevel')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div className="mic-test-level" style={{ transform: `scaleX(${level})` }} />
        </div>
      </div>
      {testError && <p className="error-text">{testError}</p>}

      <h6 id="settings-noise-suppression" className="voice-settings-heading">{t('settings.voice.noiseSuppression')}</h6>
      <div role="radiogroup" aria-label={t('settings.voice.noiseSuppression')}>
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
                {t(label)}
                <span className="vc-hint">
                  {mode === 'strong' && !strongAvailable ? t('settings.voice.noise.strong.unavailable') : t(hint)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {settings.noiseSuppression === 'strong' && strongSlow && (
        <p className="error-text">{t('settings.voice.noise.strong.tooSlow')}</p>
      )}

      <h6 id="settings-input-sensitivity" className="voice-settings-heading">{t('settings.voice.inputSensitivity')}</h6>
      <label className="settings-toggle voice-settings-toggle">
        <input
          type="checkbox" checked={settings.autoSensitivity}
          onChange={(e) => setAudioSettings({ autoSensitivity: e.target.checked })}
        />
        <span>
          {t('settings.voice.autoSensitivity.label')}
          <span className="vc-hint">
            {t('settings.voice.autoSensitivity.hint')}
          </span>
        </span>
      </label>
      {!settings.autoSensitivity && (
        <div className="voice-sensitivity">
          <input
            type="range" min={ALWAYS_OPEN_DB} max="0" step="1"
            aria-label={t('settings.voice.inputSensitivity')}
            value={settings.sensitivity}
            onChange={(e) => setAudioSettings({ sensitivity: Number(e.target.value) })}
          />
          <div
            className="voice-sensitivity-meter"
            role="meter" aria-label={t('settings.voice.levelAgainstSensitivity')} aria-valuemin={ALWAYS_OPEN_DB} aria-valuemax={0}
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
              ? t('settings.voice.alwaysSending')
              : t('settings.voice.sendsLouderThan', { db: settings.sensitivity })}
            {!testing && ` ${t('settings.voice.useLetsCheck')}`}
          </p>
        </div>
      )}

      <h6 id="settings-voice-processing" className="voice-settings-heading">{t('settings.voice.voiceProcessing')}</h6>
      {PROCESSING.map(([key, label, hint]) => (
        <label key={key} className="settings-toggle voice-settings-toggle">
          <input type="checkbox" checked={settings[key]} onChange={(e) => setAudioSettings({ [key]: e.target.checked })} />
          <span>
            {t(label)}
            <span className="vc-hint">{t(hint)}</span>
          </span>
        </label>
      ))}
      <h6 id="settings-soundboard" className="voice-settings-heading">{t('settings.voice.soundboard.title')}</h6>
      <p className="vc-hint">{t('settings.voice.soundboard.hint')}</p>
      {SOUNDBOARD.map(([on, volume, key]) => (
        <div key={key} className="voice-settings-soundboard">
          <label className="settings-toggle voice-settings-toggle">
            <input type="checkbox" checked={settings[on]} onChange={(e) => setAudioSettings({ [on]: e.target.checked })} />
            <span>
              {t(`settings.voice.soundboard.${key}.label`)}
              <span className="vc-hint">{t(`settings.voice.soundboard.${key}.hint`)}</span>
            </span>
          </label>
          <label className="voice-settings-field">
            <span>{t(`settings.voice.soundboard.${key}.volume`)}</span>
            <span className="sound-volume">
              <input
                type="range" min="0" max="100" step="1"
                aria-label={t(`settings.voice.soundboard.${key}.volume`)}
                disabled={!settings[on]}
                value={Math.round(settings[volume] * 100)}
                onChange={(e) => setAudioSettings({ [volume]: Number(e.target.value) / 100 })}
              />
              <span className="sound-volume-value">{Math.round(settings[volume] * 100)}%</span>
            </span>
          </label>
        </div>
      ))}
      <CameraSettings />
      {canShareScreen() && (
        <>
          <h6 id="settings-screen-share" className="voice-settings-heading">{t('settings.voice.screenShare')}</h6>
          <StreamQualityPicker />
          <p className="vc-hint">{t('settings.voice.screenShareHint')}</p>
        </>
      )}
      <div className="voice-settings-footer">
        <span className="vc-hint">{t('settings.savedOnDevice')}</span>
        <button type="button" className="btn btn-link btn-sm" onClick={resetAudioSettings}>{t('settings.voice.reset')}</button>
      </div>
    </div>
  );
}
