import React from 'react';
import { useVoice } from '../../hooks/useVoice';
import { setSelfDeaf, setSelfMute } from '../../voice/voiceClient';
import { HeadphonesIcon, MicIcon } from './VoiceIcons';

// Mute and deafen buttons (in the user panel, and the voice channel view). They work outside
// a call too: you join the next one that way.
export default function VoiceControls({ className = 'user-panel-button' }) {
  const { selfMute, selfDeaf } = useVoice();
  const muted = selfMute || selfDeaf;
  return (
    <>
      <button
        type="button"
        className={`${className} voice-toggle${muted ? ' off' : ''}`}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute' : 'Mute'}
        onClick={() => setSelfMute(!muted)}
      >
        <MicIcon muted={muted} />
      </button>
      <button
        type="button"
        className={`${className} voice-toggle${selfDeaf ? ' off' : ''}`}
        aria-pressed={selfDeaf}
        aria-label={selfDeaf ? 'Undeafen' : 'Deafen'}
        title={selfDeaf ? 'Undeafen' : 'Deafen'}
        onClick={() => setSelfDeaf(!selfDeaf)}
      >
        <HeadphonesIcon deafened={selfDeaf} />
      </button>
    </>
  );
}
