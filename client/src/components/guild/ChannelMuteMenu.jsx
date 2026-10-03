import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { muteChannel, unmuteChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { useDateFormat } from '../../utils/dateFormat';
import { MUTE_DURATIONS, mutedUntilText } from '../../utils/channelMutes';
import { t } from '../../i18n';

const MARGIN = 8;

// Mute or unmute a channel (your own setting, like Discord's): a menu floating by `anchor` (a
// rect: the channel header's bell button; `align` 'end' lines its right edge up with the
// anchor's; the channel list's menu, ChannelMenu, has the same choices), kept on screen; closes on a pick, a click
// elsewhere or Escape. A muted channel isn't marked unread and doesn't notify, except when
// someone mentions you.
export default function ChannelMuteMenu({ channel, anchor, align = 'start', onClose }) {
  useDateFormat();
  const { guildList } = useContext(LayoutContext);
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom, visibility: 'hidden' });
  const [error, setError] = useState(null);
  const mute = guildList.mutes[channel.id];

  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect();
    let left = align === 'end' ? anchor.right - box.width : anchor.left;
    let top = anchor.bottom + (anchor.bottom > anchor.top ? 6 : 0);
    if (top + box.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, anchor.top - box.height);
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));
    setPosition({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  async function save(change) {
    setError(null);
    try {
      guildList.applyMute(await change());
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return createPortal(
    <div className="guild-menu channel-mute-menu" ref={ref} style={position} role="menu" aria-label={t('guildAdmin.channelMenu.muteLabel', { name: channel.name })}>
      {mute ? (
        <>
          <button type="button" role="menuitem" className="guild-menu-item" onClick={() => save(() => unmuteChannel(channel.id))}>
            {t('guildAdmin.channelMenu.unmute')} <FontAwesomeIcon icon={faBell} />
          </button>
          <p className="channel-mute-until">{mutedUntilText(mute.until)}</p>
        </>
      ) : (
        <>
          <p className="channel-mute-title"><FontAwesomeIcon icon={faBellSlash} /> {t('guildAdmin.channelMenu.mute')}</p>
          {MUTE_DURATIONS.map(([label, duration]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="guild-menu-item"
              onClick={() => save(() => muteChannel(channel.id, duration))}
            >
              {label}
            </button>
          ))}
        </>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>,
    document.body
  );
}
