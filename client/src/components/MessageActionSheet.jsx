import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faCopy, faEdit, faLinkSlash, faReply, faRobot, faThumbtack, faTrash, faFlag } from '@fortawesome/free-solid-svg-icons';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { quickReactions } from '../emoji/quickReactions';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';

// Mobile: what a long press on a message opens (in place of the desktop hover menu). A row of
// quick reactions (plus the full picker), then Reply / Edit / Pin (or Unpin) / Create thread / Copy text /
// Remove previews (`onRemovePreviews`, when you may) / Delete. Actions the
// message doesn't allow are left out: nothing but copying for one still sending or failed,
// and editing only your own (deleting: your own, or `canDelete`, e.g. a guild's owner; pinning:
// `onTogglePin`, when you may).
// `apps` (a guild channel's bots' message commands) are listed under Apps; `onRunApp(command)`.
// `onClose` also runs after any action.
export default function MessageActionSheet({
  msg,
  isOwn,
  canDelete = isOwn,
  canReact = true,
  myReactions,
  onReact,
  onMoreReactions,
  onReply,
  onEdit,
  onTogglePin,
  onCreateThread,
  onCopy,
  onRemovePreviews,
  onDelete,
  onReport,
  apps = [],
  onRunApp,
  onClose,
}) {
  const index = useEmojiIndex();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Lifting the finger that long-pressed the message fires a click where it is, which is now
  // on this sheet (or its backdrop). Only clicks from a touch that started here count.
  const touchedHere = useRef(false);
  const sent = msg.status !== 'pending' && msg.status !== 'failed';

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = (action) => () => {
    action();
    onClose();
  };

  return (
    <div
      className="action-sheet-backdrop"
      onPointerDown={() => { touchedHere.current = true; }}
      onClickCapture={(e) => {
        if (!touchedHere.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={onClose}
    >
      <div
        className="action-sheet"
        role="dialog"
        aria-label={t('chat.messageMenu.label')}
        onClick={(e) => e.stopPropagation()}
      >
        {sent && canReact && index && !confirmingDelete && (
          <div className="action-sheet-reactions" role="group" aria-label={t('chat.messageMenu.react')}>
            {quickReactions(index).map(({ emoji, skin }) => (
              <button
                key={emoji.id}
                type="button"
                className={`action-sheet-reaction${myReactions.has(skin.native) ? ' mine' : ''}`}
                aria-label={t('chat.messageMenu.reactWith', { name: emoji.name })}
                aria-pressed={myReactions.has(skin.native)}
                onClick={act(() => onReact(skin.native))}
              >
                <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} draggable={false} />
              </button>
            ))}
            <button
              type="button"
              className="action-sheet-reaction action-sheet-more"
              aria-label={t('chat.messageMenu.moreReactions')}
              onClick={() => { onClose(); onMoreReactions(); }}
            >
              +
            </button>
          </div>
        )}

        {confirmingDelete ? (
          <div className="action-sheet-confirm">
            <p>{t('chat.messageMenu.confirmDelete')}</p>
            <button type="button" className="action-sheet-item danger" onClick={act(onDelete)}>
              <FontAwesomeIcon icon={faTrash} /> {t('common.delete')}
            </button>
            <button type="button" className="action-sheet-item" onClick={() => setConfirmingDelete(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <div className="action-sheet-items">
            {sent && (
              <button type="button" className="action-sheet-item" onClick={act(onReply)}>
                <FontAwesomeIcon icon={faReply} /> {t('common.reply')}
              </button>
            )}
            {sent && isOwn && onEdit && (
              <button type="button" className="action-sheet-item" onClick={act(onEdit)}>
                <FontAwesomeIcon icon={faEdit} /> {t('common.edit')}
              </button>
            )}
            {sent && onTogglePin && (
              <button type="button" className="action-sheet-item" onClick={act(onTogglePin)}>
                <FontAwesomeIcon icon={faThumbtack} /> {msg.pinned_at ? t('chat.messageMenu.unpinSheet') : t('chat.messageMenu.pinSheet')}
              </button>
            )}
            {sent && onCreateThread && (
              <button type="button" className="action-sheet-item" onClick={act(onCreateThread)}>
                <FontAwesomeIcon icon={faComments} /> {t('chat.messageMenu.createThreadSheet')}
              </button>
            )}
            {msg.plaintext && (
              <button type="button" className="action-sheet-item" onClick={act(onCopy)}>
                <FontAwesomeIcon icon={faCopy} /> {t('chat.messageMenu.copyTextSheet')}
              </button>
            )}
            {sent && onRemovePreviews && (
              <button type="button" className="action-sheet-item" onClick={act(onRemovePreviews)}>
                <FontAwesomeIcon icon={faLinkSlash} /> {t('chat.messageMenu.removePreviewsSheet')}
              </button>
            )}
            {sent && apps.length > 0 && (
              <div className="action-sheet-apps" role="group" aria-label={t('commands.apps.label')}>
                <div className="action-sheet-heading">{t('commands.apps.label')}</div>
                {apps.map((command) => (
                  <button key={command.id} type="button" className="action-sheet-item" onClick={act(() => onRunApp(command))}>
                    <FontAwesomeIcon icon={faRobot} /> {command.name}
                    <span className="action-sheet-hint">{displayName(command.bot?.id, command.bot?.name)}</span>
                  </button>
                ))}
              </div>
            )}
            {sent && !isOwn && onReport && (
              <button type="button" className="action-sheet-item danger" onClick={act(onReport)}>
                <FontAwesomeIcon icon={faFlag} /> {t('chat.report.menuMessage')}
              </button>
            )}
            {sent && canDelete && (
              <button type="button" className="action-sheet-item danger" onClick={() => setConfirmingDelete(true)}>
                <FontAwesomeIcon icon={faTrash} /> {t('common.delete')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
