import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onDeviceChange } from '../voice/audioSettings';
import { cameraOptions, listCameras, setVideoSettings, useVideoSettings } from '../voice/videoSettings';
import { t } from '../i18n';

function cameraTestError(err) {
  if (err?.name === 'NotAllowedError') return t('settings.voice.cameraBlocked');
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return t('settings.voice.noCamera');
  return t('settings.voice.cameraFailed');
}

// The camera part of Settings → Voice & video: which camera (voice/videoSettings.js), and a
// preview of it (mirrored, as your own tile shows it). Only captured while testing.
export default function CameraSettings() {
  const { cameraDeviceId } = useVideoSettings();
  const [{ cameras, labelled }, setCameras] = useState({ cameras: [], labelled: true });
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

  const refresh = useCallback(() => {
    listCameras().then(setCameras).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return onDeviceChange(refresh);
  }, [refresh]);

  useEffect(() => {
    if (!testing) return undefined;
    let stream = null;
    let cancelled = false;
    setError(null);
    const { resolution, ...constraints } = cameraOptions();
    navigator.mediaDevices.getUserMedia({ video: { ...constraints, width: { ideal: resolution.width }, height: { ideal: resolution.height } } })
      .then((captured) => {
        if (cancelled) {
          for (const track of captured.getTracks()) track.stop();
          return;
        }
        stream = captured;
        if (videoRef.current) videoRef.current.srcObject = captured;
        refresh(); // names show once the page may use the camera
      })
      .catch((err) => {
        if (cancelled) return;
        setError(cameraTestError(err));
        setTesting(false);
      });
    return () => {
      cancelled = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [testing, cameraDeviceId, refresh]);

  const missing = cameraDeviceId && !cameras.some((c) => c.id === cameraDeviceId);

  return (
    <>
      <h6 id="settings-camera" className="voice-settings-heading">{t('settings.voice.video')}</h6>
      <div className="voice-settings-grid">
        <label className="voice-settings-field">
          <span>{t('settings.voice.camera')}</span>
          <select
            aria-label={t('settings.voice.camera')}
            value={cameraDeviceId}
            onChange={(e) => setVideoSettings({ cameraDeviceId: e.target.value })}
          >
            <option value="">{t('settings.voice.defaultDevice')}</option>
            {cameras.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            {missing && <option value={cameraDeviceId}>{t('settings.voice.notConnected')}</option>}
          </select>
        </label>
      </div>
      {!labelled && <p className="vc-hint">{t('settings.voice.cameraNamesHidden')}</p>}
      <div className="camera-test">
        {testing && (
          <video ref={videoRef} className="camera-video mirrored camera-test-preview" autoPlay playsInline muted aria-label={t('settings.voice.cameraPreview')} />
        )}
        <button
          type="button"
          className={`btn btn-sm ${testing ? 'btn-secondary' : 'btn-primary vc-button'}`}
          onClick={() => setTesting((on) => !on)}
        >
          {testing ? t('settings.voice.stopCameraTest') : t('settings.voice.testCamera')}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}
