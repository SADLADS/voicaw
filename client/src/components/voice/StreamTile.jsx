import React, { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useVoice } from '../../hooks/useVoice';
import { attachStream, focusCamera, watchStream } from '../../voice/voiceClient';
import { fullScreenStage } from '../../voice/fullScreen';
import { t } from '../../i18n';

// A stream being watched while a camera is focused: still playing, with its sound, small among
// the people. A click (or Enter) brings it back to the stage, a double click to full screen too.
export default function StreamTile({ userId, name, own, as = 'li' }) {
  const Tag = as;
  const { watchingReady } = useVoice();
  const videoRef = useRef(null);
  useEffect(() => (watchingReady ? attachStream(userId, videoRef.current) : undefined), [userId, watchingReady]);
  const label = own ? t('voice.stream.yourStream') : t('voice.stream.screenOf', { name });
  return (
    <Tag
      className="voice-tile video camera-tile stream-tile"
      role="button"
      tabIndex={0}
      title={t('voice.stream.bringToStage')}
      onClick={(e) => {
        e.stopPropagation();
        if (e.detail <= 1) focusCamera(null);
      }}
      onDoubleClick={fullScreenStage}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        focusCamera(null);
      }}
    >
      <video ref={videoRef} className="camera-video voice-tile-video stream-tile-video" autoPlay playsInline muted aria-label={label} />
      <button
        type="button"
        className="stream-tile-stop"
        aria-label={t('voice.stream.stopWatching')}
        title={t('voice.stream.stopWatching')}
        onClick={(e) => {
          e.stopPropagation();
          watchStream(null);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon icon={faXmark} fixedWidth />
      </button>
      <span className="voice-tile-name">{label}</span>
      <span className="voice-tile-icons">
        <span className="voice-live-badge">{t('voice.stream.live')}</span>
      </span>
    </Tag>
  );
}
