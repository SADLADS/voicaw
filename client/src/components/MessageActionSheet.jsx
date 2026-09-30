import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faEdit, faReply, faThumbtack, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { frequentEmojiIds, getSkinTone, skinFor } from '../emoji/emojiUsage';

// Offered first, after the person's own most used emoji.
const DEFAULT_QUICK_REACTIONS = ['+1', 'heart', 'joy', 'open_mouth', 'cry', 'pray'];
const QUICK_REACTION_COUNT = 6;

function quickReactions(index) {
  const tone = getSkinTone();
  const ids = [...new Set([...frequentEmojiIds(QUICK_REACTION_COUNT), ...DEFAULT_QUICK_REACTIONS])];
  return ids
    .map((id) => index.emojis.get(id))
    .filter(Boolean)
    .slice(0, QUICK_REACTION_COUNT)
    .map((emoji) => ({ emoji, skin: skinFor(emoji, tone) }));
}

// Mobile: what a long press on a message opens (in place of the desktop hover menu). A row of
// quick reactions (plus the full picker), then Reply / Edit / Pin (or Unpin) / Copy text / Delete. Actions the
// message doesn't allow are left out: nothing but copying for one still sending or failed,
// and editing only your own (deleting: your own, or `canDelete`, e.g. a guild's owner; pinning:
// `onTogglePin`, when you may).
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
  onCopy,
  onDelete,
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
        aria-label="Message actions"
        onClick={(e) => e.stopPropagation()}
      >
        {sent && canReact && index && !confirmingDelete && (
          <div className="action-sheet-reactions" role="group" aria-label="React">
            {quickReactions(index).map(({ emoji, skin }) => (
              <button
                key={emoji.id}
                type="button"
                className={`action-sheet-reaction${myReactions.has(skin.native) ? ' mine' : ''}`}
                aria-label={`React with ${emoji.name}`}
                aria-pressed={myReactions.has(skin.native)}
                onClick={act(() => onReact(skin.native))}
              >
                <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} draggable={false} />
              </button>
            ))}
            <button
              type="button"
              className="action-sheet-reaction action-sheet-more"
              aria-label="More reactions"
              onClick={() => { onClose(); onMoreReactions(); }}
            >
              +
            </button>
          </div>
        )}

        {confirmingDelete ? (
          <div className="action-sheet-confirm">
            <p>Delete this message? This can't be undone.</p>
            <button type="button" className="action-sheet-item danger" onClick={act(onDelete)}>
              <FontAwesomeIcon icon={faTrash} /> Delete
            </button>
            <button type="button" className="action-sheet-item" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="action-sheet-items">
            {sent && (
              <button type="button" className="action-sheet-item" onClick={act(onReply)}>
                <FontAwesomeIcon icon={faReply} /> Reply
              </button>
            )}
            {sent && isOwn && (
              <button type="button" className="action-sheet-item" onClick={act(onEdit)}>
                <FontAwesomeIcon icon={faEdit} /> Edit
              </button>
            )}
            {sent && onTogglePin && (
              <button type="button" className="action-sheet-item" onClick={act(onTogglePin)}>
                <FontAwesomeIcon icon={faThumbtack} /> {msg.pinned_at ? 'Unpin message' : 'Pin message'}
              </button>
            )}
            {msg.plaintext && (
              <button type="button" className="action-sheet-item" onClick={act(onCopy)}>
                <FontAwesomeIcon icon={faCopy} /> Copy text
              </button>
            )}
            {sent && canDelete && (
              <button type="button" className="action-sheet-item danger" onClick={() => setConfirmingDelete(true)}>
                <FontAwesomeIcon icon={faTrash} /> Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
