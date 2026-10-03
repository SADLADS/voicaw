import React from 'react';
import { faComments, faCopy, faEdit, faFaceSmile, faReply, faThumbtack, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { quickReactions } from '../emoji/quickReactions';
import ContextMenu from './ContextMenu';

const QUICK_REACTION_COUNT = 5; // what fits across the menu

// Desktop: a message's right-click menu, Discord style (the phone's long press opens
// MessageActionSheet instead). A row of quick reactions, then Add Reaction (the full picker,
// by the pointer), Reply, Edit, Pin / Unpin, Create Thread (`onCreateThread`, in a guild text
// channel), Copy Text and Delete. What the message doesn't
// allow is left out, as in the sheet: only copying for one still sending or failed, editing
// only your own (`onEdit`, not given for a closed poll), deleting your own or with
// `canDelete`, pinning when `onTogglePin` is given, reacting when `canReact`.
// `onDelete(event)` asks first unless Shift is held (ChatPane's requestDelete). `onCopy`
// returns a promise; its failure shows in the menu. `anchor` is where it was right-clicked.
export default function MessageMenu({
  msg,
  isOwn,
  canDelete = isOwn,
  canReact = true,
  myReactions,
  anchor,
  onReact,
  onMoreReactions,
  onReply,
  onEdit,
  onTogglePin,
  onCreateThread,
  onCopy,
  onDelete,
  onClose,
}) {
  const index = useEmojiIndex();
  const sent = msg.status !== 'pending' && msg.status !== 'failed';

  const items = [];
  if (sent && canReact) {
    items.push({ key: 'react', label: 'Add Reaction', icon: faFaceSmile, onSelect: () => onMoreReactions(anchor) });
  }
  if (sent) items.push({ key: 'reply', label: 'Reply', icon: faReply, onSelect: onReply });
  if (sent && isOwn && onEdit) items.push({ key: 'edit', label: 'Edit Message', icon: faEdit, onSelect: onEdit });
  if (sent && onTogglePin) {
    items.push({ key: 'pin', label: msg.pinned_at ? 'Unpin Message' : 'Pin Message', icon: faThumbtack, onSelect: onTogglePin });
  }
  if (sent && onCreateThread) items.push({ key: 'thread', label: 'Create Thread', icon: faComments, onSelect: onCreateThread });
  if (msg.plaintext) {
    items.push({ key: 'copy', label: 'Copy Text', icon: faCopy, onSelect: async () => { await onCopy(); return 'Copied'; } });
  }
  if (sent && canDelete) {
    items.push({ separator: true }, { key: 'delete', label: 'Delete Message', icon: faTrash, danger: true, onSelect: onDelete });
  }

  const header = sent && canReact && index ? (
    <div className="context-menu-reactions" role="group" aria-label="React">
      {quickReactions(index, QUICK_REACTION_COUNT).map(({ emoji, skin }) => (
        <button
          key={emoji.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={myReactions.has(skin.native)}
          className={`context-menu-reaction${myReactions.has(skin.native) ? ' mine' : ''}`}
          aria-label={`React with ${emoji.name}`}
          title={`:${emoji.id}:`}
          onClick={() => { onReact(skin.native); onClose(); }}
        >
          <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} draggable={false} />
        </button>
      ))}
    </div>
  ) : null;

  return <ContextMenu label="Message actions" items={items} header={header} anchor={anchor} onClose={onClose} />;
}
