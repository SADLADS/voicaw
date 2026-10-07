import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDisplay } from '@fortawesome/free-solid-svg-icons';
import { useVoice } from '../../hooks/useVoice';
import { canShareScreen, stopScreenShare } from '../../voice/voiceClient';
import { isDesktopApp } from '../../utils/desktop';
import ScreenPicker from './ScreenPicker';
import GoLiveDialog from './GoLiveDialog';
import { t } from '../../i18n';

// Share your screen / stop sharing, while you're in a voice channel with Video. Not on phones
// (their browsers can't share a screen). Both ask for the stream's quality first: in a browser
// a small dialog (then the browser asks what to share), in the desktop app our picker.
export default function ScreenShareButton({ className = 'user-panel-button' }) {
  const voice = useVoice();
  const [picking, setPicking] = useState(false);
  const available = voice.status === 'connected' && voice.channelId != null && voice.canStream && canShareScreen();
  if (!available && !voice.streaming) return null;
  const label = voice.streaming ? t('voice.screenShare.stop') : t('voice.screenShare.start');
  const onClick = () => {
    if (voice.streaming) stopScreenShare();
    else setPicking(true);
  };
  return (
    <>
      <button
        type="button"
        className={`${className} screen-share-toggle${voice.streaming ? ' active' : ''}`}
        aria-pressed={voice.streaming}
        aria-label={label}
        title={label}
        onClick={onClick}
      >
        <FontAwesomeIcon icon={faDisplay} fixedWidth />
      </button>
      {picking && available && (isDesktopApp()
        ? <ScreenPicker onClose={() => setPicking(false)} />
        : <GoLiveDialog onClose={() => setPicking(false)} />)}
    </>
  );
}
