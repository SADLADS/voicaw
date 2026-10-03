import React, { useContext, useEffect, useRef } from 'react';
import '../../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownLeftAndUpRightToCenter, faExpand, faUpRightFromSquare, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { attachStream, setStreamError, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow, openStreamWindow } from '../../voice/streamWindow';
import { t } from '../../i18n';

// The screen share being watched, big (the voice channel view's stage, or its own window when
// popped out): the video, whose it is, pop out (or bring back), full screen and stop watching.
// Its sound plays with the rest of voice (deafen mutes it).
export default function StreamView({ userId, name, own, popout = false }) {
  const { watchingReady } = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const videoRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!watchingReady) return undefined;
    return attachStream(userId, videoRef.current);
  }, [userId, watchingReady]);

  function fullScreen() {
    // The document it's in: the pop-out window's, when it's there.
    const stage = stageRef.current;
    const doc = stage?.ownerDocument ?? document;
    if (doc.fullscreenElement) doc.exitFullscreen?.();
    else (stage?.requestFullscreen ?? stage?.webkitRequestFullscreen)?.call(stage)?.catch?.(() => {});
  }

  function popOut() {
    if (!openStreamWindow()) setStreamError(t('voice.stream.popupBlocked'));
  }

  return (
    <div className={`stream-view${popout ? ' popped-out' : ''}`} ref={stageRef} onDoubleClick={fullScreen}>
      {/* Muted: a screen share's sound plays through voice's own audio (see voiceClient). */}
      <video ref={videoRef} className="stream-video" autoPlay playsInline muted aria-label={t('voice.stream.screenOf', { name })} />
      {!watchingReady && <p className="stream-loading">{t('voice.stream.loading')}</p>}
      <div className="stream-bar">
        <span className="voice-live-badge">{t('voice.stream.live')}</span>
        <span className="stream-name">{own ? t('voice.stream.yourStream') : name}</span>
        {popout ? (
          <button type="button" className="stream-button" aria-label={t('voice.stream.bringBack')} title={t('voice.stream.bringBack')} onClick={closeStreamWindow}>
            <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} fixedWidth />
          </button>
        ) : !isMobile && (
          <button type="button" className="stream-button" aria-label={t('voice.stream.popOut')} title={t('voice.stream.popOut')} onClick={popOut}>
            <FontAwesomeIcon icon={faUpRightFromSquare} fixedWidth />
          </button>
        )}
        <button type="button" className="stream-button" aria-label={t('voice.stream.fullScreen')} title={t('voice.stream.fullScreen')} onClick={fullScreen}>
          <FontAwesomeIcon icon={faExpand} fixedWidth />
        </button>
        <button type="button" className="stream-button" aria-label={t('voice.stream.stopWatching')} title={t('voice.stream.stopWatching')} onClick={() => watchStream(null)}>
          <FontAwesomeIcon icon={faXmark} fixedWidth />
        </button>
      </div>
    </div>
  );
}
