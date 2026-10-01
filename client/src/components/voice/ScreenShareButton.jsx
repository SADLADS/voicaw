import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDisplay } from '@fortawesome/free-solid-svg-icons';
import { useVoice } from '../../hooks/useVoice';
import { canShareScreen, startScreenShare, stopScreenShare } from '../../voice/voiceClient';
import { isDesktopApp } from '../../utils/desktop';

// Share your screen / stop sharing, while you're in a voice channel with Video. Not on phones
// (their browsers can't share a screen) nor in the desktop app yet (it needs its own picker).
export default function ScreenShareButton({ className = 'user-panel-button' }) {
  const voice = useVoice();
  const available = voice.status === 'connected' && voice.channelId != null && voice.canStream &&
    canShareScreen() && !isDesktopApp();
  if (!available && !voice.streaming) return null;
  const label = voice.streaming ? 'Stop sharing your screen' : 'Share your screen';
  return (
    <button
      type="button"
      className={`${className} screen-share-toggle${voice.streaming ? ' active' : ''}`}
      aria-pressed={voice.streaming}
      aria-label={label}
      title={label}
      onClick={voice.streaming ? stopScreenShare : startScreenShare}
    >
      <FontAwesomeIcon icon={faDisplay} fixedWidth />
    </button>
  );
}
