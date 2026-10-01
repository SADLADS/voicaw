import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBell, faBellSlash } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { muteChannel, unmuteChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDateTime, formatTime, useDateFormat } from '../../utils/dateFormat';

const MARGIN = 8;

// Discord's choices.
const DURATIONS = [
  ['For 15 minutes', 15 * 60],
  ['For 1 hour', 60 * 60],
  ['For 3 hours', 3 * 60 * 60],
  ['For 8 hours', 8 * 60 * 60],
  ['For 24 hours', 24 * 60 * 60],
  ['Until I turn it back on', null],
];

// When a mute ends, in words: "Muted until 16:37" (another day: with the date).
function mutedUntilText(until) {
  if (until == null) return 'Muted until you unmute it';
  const end = new Date(until * 1000);
  return `Muted until ${end.toDateString() === new Date().toDateString() ? formatTime(end) : formatDateTime(end)}`;
}

// Mute or unmute a channel (your own setting, like Discord's): a menu floating by `anchor` (a
// rect: the header's bell button, or where the channel list was right-clicked; `align` 'end'
// lines its right edge up with the anchor's), kept on screen; closes on a pick, a click
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
    <div className="guild-menu channel-mute-menu" ref={ref} style={position} role="menu" aria-label={`Mute #${channel.name}`}>
      {mute ? (
        <>
          <button type="button" role="menuitem" className="guild-menu-item" onClick={() => save(() => unmuteChannel(channel.id))}>
            Unmute Channel <FontAwesomeIcon icon={faBell} />
          </button>
          <p className="channel-mute-until">{mutedUntilText(mute.until)}</p>
        </>
      ) : (
        <>
          <p className="channel-mute-title"><FontAwesomeIcon icon={faBellSlash} /> Mute Channel</p>
          {DURATIONS.map(([label, duration]) => (
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
