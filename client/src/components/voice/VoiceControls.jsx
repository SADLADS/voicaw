import React from 'react';
import { useVoice } from '../../hooks/useVoice';
import { setSelfDeaf, setSelfMute } from '../../voice/voiceClient';
import { HeadphonesIcon, MicIcon } from './VoiceIcons';
import { t } from '../../i18n';

// Mute and deafen buttons (in the user panel, and the voice channel view). They work outside
// a call too: you join the next one that way. The mic test holds both on (voiceClient).
export default function VoiceControls({ className = 'user-panel-button' }) {
  const { selfMute, selfDeaf, micTesting } = useVoice();
  const muted = selfMute || selfDeaf;
  const testing = micTesting ? t('voice.controls.micTesting') : null;
  return (
    <>
      <button
        type="button"
        className={`${className} voice-toggle${muted ? ' off' : ''}`}
        aria-pressed={muted}
        aria-label={muted ? t('common.unmute') : t('common.mute')}
        title={testing ?? (muted ? t('common.unmute') : t('common.mute'))}
        disabled={micTesting}
        onClick={() => setSelfMute(!muted)}
      >
        <MicIcon muted={muted} />
      </button>
      <button
        type="button"
        className={`${className} voice-toggle${selfDeaf ? ' off' : ''}`}
        aria-pressed={selfDeaf}
        aria-label={selfDeaf ? t('voice.controls.undeafen') : t('voice.controls.deafen')}
        title={testing ?? (selfDeaf ? t('voice.controls.undeafen') : t('voice.controls.deafen'))}
        disabled={micTesting}
        onClick={() => setSelfDeaf(!selfDeaf)}
      >
        <HeadphonesIcon deafened={selfDeaf} />
      </button>
    </>
  );
}
