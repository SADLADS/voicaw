import React, { useEffect, useRef, useState } from 'react';
import UserAvatar from './UserAvatar';
import { showCamera } from '../../voice/voiceClient';
import { useVoice } from '../../hooks/useVoice';
import { t } from '../../i18n';

// Someone's camera (yours mirrored, as in a mirror, unless it's a phone's back camera), filling
// its tile, their picture showing through until the first frame arrives. It's only downloaded
// while shown (voiceClient's showCamera), so not while scrolled out of a row or a long grid.
// Muted: a camera has no sound of its own.
export default function CameraVideo({ userId, name, own = false, className = '' }) {
  const videoRef = useRef(null);
  const { cameraFacing } = useVoice();
  const mirrored = own && cameraFacing !== 'environment';
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(videoRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => (inView ? showCamera(userId, videoRef.current) : undefined), [userId, inView]);
  return (
    <>
      <UserAvatar userId={userId} className="camera-placeholder" />
      <video
        ref={videoRef}
        className={`camera-video${mirrored ? ' mirrored' : ''} ${className}`}
        autoPlay
        playsInline
        muted
        aria-label={own ? t('voice.camera.yourCamera') : t('voice.camera.cameraOf', { name })}
      />
    </>
  );
}
