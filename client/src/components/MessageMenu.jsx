import React from 'react';
import { faComments, faCopy, faEdit, faFaceSmile, faLinkSlash, faReply, faRobot, faThumbtack, faTrash, faFlag, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { useEmojiIndex } from '../emoji/emojiContext';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import { quickReactions } from '../emoji/quickReactions';
import ContextMenu from './ContextMenu';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';

const QUICK_REACTION_COUNT = 5; // what fits across the menu

// Desktop: a message's right-click menu, Discord style (the phone's long press opens
// MessageActionSheet instead). A row of quick reactions, then Add Reaction (the full picker,
// by the pointer), Reply, Edit, Pin / Unpin, Create Thread (`onCreateThread`, in a guild text
// channel), Copy Text, Edit History (`onShowEdits`, for an edited message), Remove Previews (`onRemovePreviews`: a guild message's link previews and
// embeds, for its author or Manage Messages) and Delete. What the message doesn't
// allow is left out, as in the sheet: only copying for one still sending or failed, editing
// only your own (`onEdit`, not given for a closed poll or a voice message), deleting your own or with
// `canDelete`, pinning when `onTogglePin` is given, reacting when `canReact`.
// `onDelete(event)` asks first unless Shift is held (ChatPane's requestDelete). `onCopy`
// returns a promise; its failure shows in the menu. `anchor` is where it was right-clicked.
// `apps` (a guild channel's bots' message commands) go in an Apps submenu; `onRunApp(command)`.
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
  onShowEdits,
  onRemovePreviews,
  onDelete,
  onReport,
  apps = [],
  onRunApp,
  onClose,
}) {
  const index = useEmojiIndex();
  const custom = useCustomEmoji();
  const sent = msg.status !== 'pending' && msg.status !== 'failed';

  const items = [];
  if (sent && canReact) {
    items.push({ key: 'react', label: t('chat.messageMenu.addReaction'), icon: faFaceSmile, onSelect: () => onMoreReactions(anchor) });
  }
  if (sent && onReply) items.push({ key: 'reply', label: t('common.reply'), icon: faReply, onSelect: onReply });
  if (sent && isOwn && onEdit) items.push({ key: 'edit', label: t('chat.messageMenu.edit'), icon: faEdit, onSelect: onEdit });
  if (sent && onTogglePin) {
    items.push({ key: 'pin', label: msg.pinned_at ? t('chat.messageMenu.unpin') : t('chat.messageMenu.pin'), icon: faThumbtack, onSelect: onTogglePin });
  }
  if (sent && onCreateThread) items.push({ key: 'thread', label: t('chat.messageMenu.createThread'), icon: faComments, onSelect: onCreateThread });
  if (msg.plaintext) {
    items.push({ key: 'copy', label: t('chat.messageMenu.copyText'), icon: faCopy, onSelect: onCopy });
  }
  if (onShowEdits) items.push({ key: 'edits', label: t('chat.messageMenu.editHistory'), icon: faClockRotateLeft, onSelect: onShowEdits });
  if (sent && onRemovePreviews) {
    items.push({ key: 'previews', label: t('chat.messageMenu.removePreviews'), icon: faLinkSlash, onSelect: onRemovePreviews });
  }
  if (sent && apps.length > 0) {
    items.push({
      key: 'apps',
      label: t('commands.apps.label'),
      icon: faRobot,
      submenu: { title: t('commands.apps.label'), items: apps.map((command) => ({ key: `app-${command.id}`, label: command.name, hint: displayName(command.bot?.id, command.bot?.name), onSelect: () => onRunApp(command) })) },
    });
  }
  if (sent && (canDelete || (!isOwn && onReport))) items.push({ separator: true });
  // Someone else's message, to Voicaw's moderators (ReportDialog).
  if (sent && !isOwn && onReport) items.push({ key: 'report', label: t('chat.report.menuMessage'), icon: faFlag, danger: true, onSelect: onReport });
  if (sent && canDelete) {
    items.push({ key: 'delete', label: t('chat.messageMenu.delete'), icon: faTrash, danger: true, onSelect: onDelete });
  }

  const header = sent && canReact && index ? (
    <div className="context-menu-reactions" role="group" aria-label={t('chat.messageMenu.react')}>
      {quickReactions(index, QUICK_REACTION_COUNT, custom).map(({ id, text, name, title, alt, src }) => (
        <button
          key={id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={myReactions.has(text)}
          className={`context-menu-reaction${myReactions.has(text) ? ' mine' : ''}`}
          aria-label={t('chat.messageMenu.reactWith', { name })}
          title={title}
          onClick={() => { onReact(text); onClose(); }}
        >
          <img className="emoji" src={src} alt={alt} draggable={false} />
        </button>
      ))}
    </div>
  ) : null;

  return <ContextMenu label={t('chat.messageMenu.label')} items={items} header={header} anchor={anchor} onClose={onClose} />;
}
