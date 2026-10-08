import React, { useContext, useEffect, useRef } from 'react';
import '../../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRight, faDownLeftAndUpRightToCenter, faExpand, faUpRightFromSquare, faVolumeHigh, faVolumeXmark, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { useShowsStreamOnPage } from '../../hooks/useStreamOnPage';
import { attachStream, setStreamError, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow, openStreamWindow } from '../../voice/streamWindow';
import { DEFAULT_USER_VOLUME, MAX_USER_VOLUME, setStreamVolume, useStreamVolume } from '../../voice/userVolumes';
import { t } from '../../i18n';

// The screen share being watched, big (the voice channel view's stage, or its own window when
// popped out) or small in a corner (`corner`, StreamCorner, while no page shows it; `onOpen`
// goes to its channel or call, `openLabel` saying which): the video, whose it is, its volume, pop out (or bring back),
// full screen and stop watching. Its sound plays with the rest of voice (deafen mutes it), at the stream's own volume
// on this device (like Discord's Stream Volume, userVolumes.js); not for our own, which we don't
// hear.
export default function StreamView({ userId, name, own, popout = false, corner = false, onOpen, openLabel }) {
  const { watchingReady, selfDeaf } = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  useShowsStreamOnPage(!popout && !corner);

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
    <div className={`stream-view${popout ? ' popped-out' : ''}${corner ? ' corner' : ''}`} ref={stageRef} onDoubleClick={fullScreen}>
      {/* Muted: a screen share's sound plays through voice's own audio (see voiceClient). */}
      <video ref={videoRef} className="stream-video" autoPlay playsInline muted aria-label={t('voice.stream.screenOf', { name })} />
      {!watchingReady && <p className="stream-loading">{t('voice.stream.loading')}</p>}
      <div className="stream-bar">
        {!corner && <span className="voice-live-badge">{t('voice.stream.live')}</span>}
        <span className="stream-name" title={corner ? name : undefined}>{own ? t('voice.stream.yourStream') : name}</span>
        {!own && <StreamVolume userId={userId} deafened={selfDeaf} />}
        {corner && onOpen && (
          <button type="button" className="stream-button" aria-label={openLabel} title={openLabel} onClick={onOpen}>
            <FontAwesomeIcon icon={faArrowRight} fixedWidth />
          </button>
        )}
        {popout ? (
          <button type="button" className="stream-button" aria-label={t('voice.stream.bringBack')} title={t('voice.stream.bringBack')} onClick={closeStreamWindow}>
            <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} fixedWidth />
          </button>
        ) : !isMobile && (
          <button type="button" className="stream-button" aria-label={t('voice.stream.popOut')} title={t('voice.stream.popOut')} onClick={popOut}>
            <FontAwesomeIcon icon={faUpRightFromSquare} fixedWidth />
          </button>
        )}
        {!corner && (
          <button type="button" className="stream-button" aria-label={t('voice.stream.fullScreen')} title={t('voice.stream.fullScreen')} onClick={fullScreen}>
            <FontAwesomeIcon icon={faExpand} fixedWidth />
          </button>
        )}
        <button type="button" className="stream-button" aria-label={t('voice.stream.stopWatching')} title={t('voice.stream.stopWatching')} onClick={() => watchStream(null)}>
          <FontAwesomeIcon icon={faXmark} fixedWidth />
        </button>
      </div>
    </div>
  );
}

function StreamVolume({ userId, deafened }) {
  const volume = useStreamVolume(userId);
  // What unmuting goes back to.
  const unmutedRef = useRef(DEFAULT_USER_VOLUME);
  if (volume > 0) unmutedRef.current = volume;
  const muted = deafened || volume === 0;
  const percent = Math.round(volume * 100);

  return (
    <span className="stream-volume">
      <button
        type="button"
        className="stream-button"
        aria-label={muted ? t('voice.stream.unmute') : t('voice.stream.mute')}
        title={deafened ? t('voice.stream.deafened') : muted ? t('voice.stream.unmute') : t('voice.stream.mute')}
        aria-pressed={volume === 0}
        disabled={deafened}
        onClick={() => setStreamVolume(userId, volume === 0 ? unmutedRef.current : 0)}
      >
        <FontAwesomeIcon icon={muted ? faVolumeXmark : faVolumeHigh} fixedWidth />
      </button>
      <input
        type="range"
        className="stream-volume-slider"
        min={0}
        max={MAX_USER_VOLUME * 100}
        step={1}
        value={percent}
        disabled={deafened}
        aria-label={t('voice.stream.volume')}
        aria-valuetext={t('voice.stream.percent', { percent })}
        title={t('voice.stream.percent', { percent })}
        onChange={(e) => setStreamVolume(userId, Number(e.target.value) / 100)}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}
