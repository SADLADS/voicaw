import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import '../../assets/css/voice.css';
import { Icon } from '../Icon';
import { faGear, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { ReactionEmoji } from '../MessageReactions';
import { LayoutContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { playSoundboardSound, previewSound, useSoundboard } from '../../voice/soundboard';
import { PERMISSIONS, has } from '../../utils/permissions';
import { placeMenu } from '../../utils/menuPlacement';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// The soundboard (like Discord's), opened from the voice controls while you're in one of a
// guild's voice channels: its sounds as buttons, a click playing one for everyone in the
// channel (Speak and Use Soundboard, not deafened), the speaker beside each playing it to you
// alone (your join sound is chosen in your profile). Floating by `anchor` (a rect) on a computer, a
// sheet from the bottom on a phone (`sheet`). Escape, or a click outside (but on `trigger`, the
// button that opened it), closes it.
export default function SoundboardPanel({ guildId, channelId, anchor, trigger = null, sheet = false, onClose }) {
  const voice = useVoice();
  const board = useSoundboard(guildId);
  const { guildList } = useContext(LayoutContext);
  const layout = guildList?.layouts?.[guildId];
  const channel = layout?.channels?.find((c) => c.id === channelId);
  // Unknown (no layout): let the server decide.
  const allowed = !channel || has(channel.my_permissions, PERMISSIONS.SPEAK | PERMISSIONS.USE_SOUNDBOARD);
  const canManage = has(layout?.my_permissions, PERMISSIONS.MANAGE_EMOJIS);
  const [error, setError] = useState(null);
  const rootRef = useRef(null);
  const [position, setPosition] = useState({ left: anchor?.left ?? 0, top: anchor?.top ?? 0, visibility: 'hidden' });

  useLayoutEffect(() => {
    if (sheet || !anchor) return;
    setPosition(placeMenu(anchor, rootRef.current.getBoundingClientRect(), false));
  }, [anchor, sheet, board]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    if (sheet) return () => window.removeEventListener('keydown', onKey);
    const onDown = (e) => {
      // (Its own button toggles it.)
      if (!rootRef.current?.contains(e.target) && !trigger?.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [sheet, trigger, onClose]);

  async function play(sound) {
    setError(null);
    try {
      await playSoundboardSound(guildId, channelId, sound.id);
    } catch (err) {
      // Played too often: that one just doesn't play.
      if (err?.response?.status !== 429) setError(errorMessage(err));
    }
  }

  const sounds = board?.sounds ?? [];
  const note = !allowed ? t('voice.soundboard.noPermission') : voice.selfDeaf ? t('voice.soundboard.deafened') : null;
  const body = (
    <>
      {note && <p className="soundboard-note">{note}</p>}
      {board == null ? (
        <p className="vc-hint soundboard-empty">{t('common.loading')}</p>
      ) : sounds.length === 0 ? (
        <p className="vc-hint soundboard-empty">{canManage ? t('voice.soundboard.emptyManage') : t('voice.soundboard.empty')}</p>
      ) : (
        <ul className="soundboard-grid" aria-label={t('voice.soundboard.sounds')}>
          {sounds.map((sound) => (
            <li key={sound.id} className="soundboard-item">
              <button
                type="button"
                className="soundboard-sound"
                disabled={!allowed || voice.selfDeaf}
                title={t('voice.soundboard.play', { name: sound.name })}
                onClick={() => play(sound)}
              >
                {sound.emoji && <span className="soundboard-emoji" aria-hidden="true"><ReactionEmoji native={sound.emoji} /></span>}
                <span className="soundboard-name">{sound.name}</span>
              </button>
              <button
                type="button"
                className="soundboard-preview"
                aria-label={t('voice.soundboard.preview', { name: sound.name })}
                title={t('voice.soundboard.preview', { name: sound.name })}
                onClick={() => previewSound(sound)}
              >
                <Icon icon={faVolumeHigh} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-msg soundboard-error" role="alert">{error}</p>}
      <div className="soundboard-footer">
        <Link
          to="/settings/voice-video#soundboard"
          className="soundboard-settings-link"
          aria-label={t('voice.soundboard.settings')}
          title={t('voice.soundboard.settings')}
          onClick={onClose}
        >
          <Icon icon={faGear} />
        </Link>
      </div>
    </>
  );

  if (sheet) {
    return createPortal(
      <div className="action-sheet-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
        <div
          className="action-sheet context-sheet soundboard-sheet"
          role="dialog"
          aria-label={t('voice.soundboard.title')}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-sheet-title"><span>{t('voice.soundboard.title')}</span></div>
          {body}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={rootRef}
      className="guild-menu context-menu soundboard-panel"
      style={position}
      role="dialog"
      aria-label={t('voice.soundboard.title')}
    >
      <div className="soundboard-head">{t('voice.soundboard.title')}</div>
      {body}
    </div>,
    document.body
  );
}
