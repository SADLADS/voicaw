import React, { useEffect } from 'react';
import { useVoice } from '../../hooks/useVoice';
import { pushToTalkDown, pushToTalkUp, usePushToTalk } from '../../voice/pushToTalk';
import { MicIcon } from './VoiceIcons';
import { t } from '../../i18n';

const SOURCE = 'button';

// Hold to talk, with push to talk on (voice/pushToTalk.js): in the voice bar and the call
// views, for phones (no key to hold) and anyone without a key chosen. Pressed with a finger,
// the mouse, or Space/Enter while focused. Muted or not allowed to speak, it's greyed out.
export default function PushToTalkButton({ className = 'user-panel-button' }) {
  const voice = useVoice();
  const { on, pressed } = usePushToTalk();
  // Taken away mid-press (left the call, push to talk turned off): let go.
  const shown = on && voice.status === 'connected';
  useEffect(() => (shown ? () => pushToTalkUp(SOURCE) : undefined), [shown]);
  if (!shown) return null;

  const disabled = !voice.canSpeak || voice.selfMute || voice.selfDeaf;
  const label = pressed ? t('voice.pushToTalk.talking') : t('voice.pushToTalk.hold');
  const down = (e) => {
    if (e.button > 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pushToTalkDown(SOURCE);
  };
  const up = () => pushToTalkUp(SOURCE);
  const onKey = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.type === 'keydown') pushToTalkDown(SOURCE);
    else up();
  };
  return (
    <button
      type="button"
      className={`${className} push-to-talk-button${pressed && !disabled ? ' active' : ''}`}
      aria-pressed={pressed}
      aria-label={label}
      title={disabled ? t('voice.pushToTalk.muted') : label}
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onKeyDown={onKey}
      onKeyUp={onKey}
      onBlur={up}
      // A long press on a phone would open the system's menu or select text.
      onContextMenu={(e) => e.preventDefault()}
    >
      <MicIcon muted={false} />
      <span className="push-to-talk-text">{t('voice.pushToTalk.short')}</span>
    </button>
  );
}
