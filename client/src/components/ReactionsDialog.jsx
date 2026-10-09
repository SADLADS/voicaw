import React, { useEffect, useState } from 'react';
import Modal from './guild/Modal';
import Avatar from './Avatar';
import { ReactionEmoji } from './MessageReactions';
import { useEmojiIndex } from '../emoji/emojiContext';
import { reactionShortName } from '../utils/reactions';
import { useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Who reacted with what, as PollVoters for a poll: a tab per emoji (with its count), starting
// on `initialEmoji`, and the people who reacted with the chosen one. `groups` is
// groupReactions' and follows the message live; `names` maps user id -> name. Your own row
// has a button taking your reaction back (`onRemove(emoji)`). Closes itself once the last
// reaction is gone.
export default function ReactionsDialog({ groups, names, userId, initialEmoji, onRemove, onClose }) {
  useProfiles(); // pictures and names follow profile changes
  const index = useEmojiIndex();
  const [current, setCurrent] = useState(initialEmoji);
  const group = groups.find((g) => g.emoji === current) ?? groups[0];

  useEffect(() => {
    if (!group) onClose();
  }, [group, onClose]);
  if (!group) return null;

  const label = (emoji) => {
    const name = reactionShortName(emoji, index);
    return name ? `:${name}:` : emoji;
  };

  return (
    <Modal title={t('chat.reactions.dialogTitle')} className="poll-voters-dialog reactions-dialog" onClose={onClose}>
      <div className="poll-voters">
        <div className="poll-voters-tabs reactions-dialog-tabs" role="tablist" aria-label={t('chat.reactions.dialogTitle')}>
          {groups.map((g) => (
            <button
              key={g.emoji}
              type="button"
              role="tab"
              aria-selected={g.emoji === group.emoji}
              aria-label={t('chat.reactions.tabLabel', { emoji: label(g.emoji), count: g.userIds.length })}
              title={label(g.emoji)}
              className={`poll-voters-tab reactions-dialog-tab${g.emoji === group.emoji ? ' active' : ''}`}
              onClick={() => setCurrent(g.emoji)}
            >
              <span className="poll-option-emoji"><ReactionEmoji native={g.emoji} /></span>
              <span className="poll-voters-tab-count">{g.userIds.length}</span>
            </button>
          ))}
        </div>
        <div className="poll-voters-list" role="tabpanel" aria-label={t('chat.reactions.reactedWith', { emoji: label(group.emoji) })}>
          <ul>
            {group.userIds.map((id) => {
              const mine = id === userId;
              const name = mine
                ? t('chat.pollVoters.you', { name: names?.[id] ?? t('chat.reactions.you') })
                : names?.[id] ?? t('chat.reactions.someone');
              return (
                <li key={id}>
                  <Avatar userId={id} alt="" className="poll-voter-avatar" />
                  <span className="reactions-dialog-name">{name}</span>
                  {mine && onRemove && (
                    <button
                      type="button"
                      className="reactions-dialog-remove"
                      aria-label={t('chat.reactions.remove')}
                      title={t('chat.reactions.remove')}
                      onClick={() => onRemove(group.emoji)}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
