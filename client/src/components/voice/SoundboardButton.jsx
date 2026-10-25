import React, { useCallback, useContext, useState } from 'react';
import { Icon } from '../Icon';
import { faMusic } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import SoundboardPanel from './SoundboardPanel';
import { t } from '../../i18n';

// Opens the soundboard (SoundboardPanel), while you're connected to a guild's voice channel.
export default function SoundboardButton({ className = 'user-panel-button' }) {
  const voice = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const [anchor, setAnchor] = useState(null);
  const close = useCallback(() => setAnchor(null), []);
  if (voice.status !== 'connected' || voice.callId != null || voice.channelId == null) return null;
  const open = anchor != null;
  return (
    <>
      <button
        type="button"
        className={`${className} soundboard-toggle${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('voice.soundboard.open')}
        title={t('voice.soundboard.open')}
        onClick={(e) => {
          if (open) return close();
          const { top, left, right } = e.currentTarget.getBoundingClientRect();
          // Above the button (the voice controls sit at the bottom of the screen).
          setAnchor({ top, bottom: top, left, right, trigger: e.currentTarget });
        }}
      >
        <Icon icon={faMusic} fixedWidth />
      </button>
      {open && (
        <SoundboardPanel guildId={voice.guildId} channelId={voice.channelId} anchor={anchor} trigger={anchor.trigger} sheet={isMobile} onClose={close} />
      )}
    </>
  );
}
