import React, { useEffect, useRef } from 'react';
import { showCamera } from '../../voice/voiceClient';
import { useVoice } from '../../hooks/useVoice';
import { t } from '../../i18n';

// Someone's camera (yours mirrored, as in a mirror, unless it's a phone's back camera), filling its tile. It's only downloaded
// while shown (voiceClient's showCamera). Muted: a camera has no sound of its own.
export default function CameraVideo({ userId, name, own = false, className = '' }) {
  const videoRef = useRef(null);
  const { cameraFacing } = useVoice();
  const mirrored = own && cameraFacing !== 'environment';
  useEffect(() => showCamera(userId, videoRef.current), [userId]);
  return (
    <video
      ref={videoRef}
      className={`camera-video${mirrored ? ' mirrored' : ''} ${className}`}
      autoPlay
      playsInline
      muted
      aria-label={own ? t('voice.camera.yourCamera') : t('voice.camera.cameraOf', { name })}
    />
  );
}
