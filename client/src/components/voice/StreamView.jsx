import React, { useEffect, useRef } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpand, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useVoice } from '../../hooks/useVoice';
import { attachStream, watchStream } from '../../voice/voiceClient';

// The screen share being watched, big (the voice channel view's stage): the video, whose it
// is, full screen and stop watching. Its sound plays with the rest of voice (deafen mutes it).
export default function StreamView({ userId, name, own }) {
  const { watchingReady } = useVoice();
  const videoRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!watchingReady) return undefined;
    return attachStream(userId, videoRef.current);
  }, [userId, watchingReady]);

  function fullScreen() {
    const stage = stageRef.current;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (stage?.requestFullscreen ?? stage?.webkitRequestFullscreen)?.call(stage)?.catch?.(() => {});
  }

  return (
    <div className="stream-view" ref={stageRef} onDoubleClick={fullScreen}>
      {/* Muted: a screen share's sound plays through voice's own audio (see voiceClient). */}
      <video ref={videoRef} className="stream-video" autoPlay playsInline muted aria-label={`${name}'s screen`} />
      {!watchingReady && <p className="stream-loading">Loading stream…</p>}
      <div className="stream-bar">
        <span className="voice-live-badge">Live</span>
        <span className="stream-name">{own ? 'Your stream' : name}</span>
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
