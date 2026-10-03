import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faThumbtack, faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from './Avatar';
import defaultAvatar from '../assets/images/default.png';
import { MessageContent } from './MessageList';
import { displayName, useProfiles } from '../utils/profiles';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

const MARGIN = 8;

// The chat's pinned messages, most recently pinned first: floating under the header's pin
// button (`anchor`, its rect) on a computer, over the whole screen on a phone. `loadPins`
// (the chat hook's) fetches and decrypts them; it runs again whenever `pinsVersion` changes (a
// pin or unpin here, from anyone). Each has Jump (`onJump`, scrolls the chat to it) and, with
// `canPin`, Unpin (`onUnpin`). Closes on Escape, a click elsewhere or the close button.
export default function PinnedMessages({
  anchor,
  isMobile,
  loadPins,
  pinsVersion,
  canPin,
  onUnpin,
  onJump,
  onClose,
  user,
  s3Endpoint,
  reactionNames,
  mentionRoles,
  myRoleIds,
  nameColors,
}) {
  useProfiles();
  useDateFormat();
  const [pins, setPins] = useState(null);
  const [error, setError] = useState(null);

  // loadPins is a new function every render; pinsVersion says when to load again.
  useEffect(() => {
    let cancelled = false;
    loadPins()
      .then((list) => { if (!cancelled) { setPins(list); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || t('chat.pins.loadFailed')); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsVersion]);

  useEffect(() => {
    const onDown = (e) => {
      // The header button toggles it itself.
      if (!e.target.closest?.('.pins-panel, .pins-button, .modal-backdrop')) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    if (!isMobile) {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('touchstart', onDown);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, isMobile]);

  async function unpin(msg) {
    setPins((list) => list?.filter((m) => m.id !== msg.id));
    try {
      await onUnpin(msg);
    } catch (err) {
      setError(err.response?.data?.error || t('chat.pins.unpinFailed'));
    }
  }

  const style = isMobile || !anchor ? undefined : {
    top: anchor.bottom + MARGIN,
    right: Math.max(MARGIN, window.innerWidth - anchor.right),
  };

  return createPortal(
    <div className={`pins-panel${isMobile ? ' mobile' : ''}`} style={style} role="dialog" aria-label={t('chat.pins.title')}>
      <div className="pins-panel-header">
        <FontAwesomeIcon icon={faThumbtack} />
        <h5>{t('chat.pins.heading')}</h5>
        <button type="button" className="icon-button pins-panel-close" aria-label={t('common.close')} onClick={onClose}>
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>
      <div className="pins-panel-list">
        {error && <p className="error-text pins-panel-note">{error}</p>}
        {pins === null && !error && <p className="pins-panel-note">{t('common.loading')}</p>}
        {pins?.length === 0 && (
          <div className="pins-panel-empty">
            <p>{t('chat.pins.empty')}</p>
            <p className="vc-hint">{canPin ? t('chat.pins.emptyCanPin') : t('chat.pins.emptyHint')}</p>
          </div>
        )}
        {pins?.map((msg) => {
          // A webhook's message: its own name and picture as sent.
          const name = msg.webhook_id ? msg.webhook_name : displayName(msg.sender_id, msg.sender_username);
          return (
            <div key={msg.id} className="pinned-message" data-pin-id={msg.id}>
              <div className="pinned-message-header">
                {msg.webhook_id ? (
                  <img src={msg.webhook_avatar || defaultAvatar} alt={name} className="pinned-message-avatar" referrerPolicy="no-referrer" />
                ) : (
                  <Avatar userId={msg.sender_id} alt={name} className="pinned-message-avatar" />
                )}
                <strong style={{ color: nameColors?.[msg.sender_id] }}>{name}</strong>
                <small title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>{formatDateTime(msg.timestamp * 1000)}</small>
                <span className="pinned-message-actions">
                  <button type="button" className="btn btn-sm pinned-message-jump" onClick={() => onJump(msg)}>{t('chat.pins.jump')}</button>
                  {canPin && (
                    <button type="button" className="icon-button" aria-label={t('common.unpin')} title={t('common.unpin')} onClick={() => unpin(msg)}>
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  )}
                </span>
              </div>
              <MessageContent
                msg={msg}
                user={user}
                s3Endpoint={s3Endpoint}
                reactionNames={reactionNames}
                mentionRoles={mentionRoles}
                myRoleIds={myRoleIds}
              />
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
