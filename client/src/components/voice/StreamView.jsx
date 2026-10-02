import React, { useContext, useEffect, useRef } from 'react';
import '../../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownLeftAndUpRightToCenter, faExpand, faUpRightFromSquare, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { attachStream, setStreamError, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow, openStreamWindow } from '../../voice/streamWindow';

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
    if (!openStreamWindow()) setStreamError('Your browser blocked the window. Allow pop-ups for Voicaw and try again.');
  }

  return (
    <div className={`stream-view${popout ? ' popped-out' : ''}`} ref={stageRef} onDoubleClick={fullScreen}>
      {/* Muted: a screen share's sound plays through voice's own audio (see voiceClient). */}
      <video ref={videoRef} className="stream-video" autoPlay playsInline muted aria-label={`${name}'s screen`} />
      {!watchingReady && <p className="stream-loading">Loading stream…</p>}
      <div className="stream-bar">
        <span className="voice-live-badge">Live</span>
        <span className="stream-name">{own ? 'Your stream' : name}</span>
        {popout ? (
          <button type="button" className="stream-button" aria-label="Bring back" title="Bring back" onClick={closeStreamWindow}>
            <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} fixedWidth />
          </button>
        ) : !isMobile && (
          <button type="button" className="stream-button" aria-label="Pop out" title="Pop out" onClick={popOut}>
            <FontAwesomeIcon icon={faUpRightFromSquare} fixedWidth />
          </button>
        )}
        <button type="button" className="stream-button" aria-label="Full screen" title="Full screen" onClick={fullScreen}>
          <FontAwesomeIcon icon={faExpand} fixedWidth />
        </button>
        <button type="button" className="stream-button" aria-label="Stop watching" title="Stop watching" onClick={() => watchStream(null)}>
          <FontAwesomeIcon icon={faXmark} fixedWidth />
        </button>
      </div>
    </div>
  );
}
