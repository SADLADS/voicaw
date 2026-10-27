import React from 'react';
import { useVoice } from '../../hooks/useVoice';
import { startCamera, stopCamera, switchCamera } from '../../voice/voiceClient';
import { isMobileDevice } from '../../utils/presence';
import { CameraIcon, SwitchCameraIcon } from './VoiceIcons';
import { t } from '../../i18n';

// Turn your camera on or off, once you're in a voice channel with Video, or in a call; on a
// phone or tablet, while it's on, a second button switches between the front and back camera.
export default function CameraButton({ className = 'user-panel-button' }) {
  const voice = useVoice();
  const available = voice.status === 'connected' && voice.canCamera;
  if (!available && !voice.cameraOn) return null;
  const label = voice.cameraOn ? t('voice.camera.stop') : t('voice.camera.start');
  return (
    <>
      <button
        type="button"
        className={`${className} camera-toggle${voice.cameraOn ? ' active' : ''}`}
        aria-pressed={voice.cameraOn}
        aria-label={label}
        title={label}
        onClick={() => (voice.cameraOn ? stopCamera() : startCamera())}
      >
        <CameraIcon off={!voice.cameraOn} />
      </button>
      {isMobileDevice() && voice.cameraOn && (
        <button
          type="button"
          className={`${className} camera-switch`}
          aria-label={t('voice.camera.switch')}
          title={t('voice.camera.switch')}
          onClick={() => switchCamera()}
        >
          <SwitchCameraIcon />
        </button>
      )}
    </>
  );
}
