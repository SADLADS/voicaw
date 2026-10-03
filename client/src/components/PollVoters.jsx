import React, { useState } from 'react';
import Modal from './guild/Modal';
import Avatar from './Avatar';
import { ReactionEmoji } from './MessageReactions';
import { useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Who voted for each answer of a poll: a tab per answer (its emoji, text and count), starting
// on `initialOption`, and the list of voters for the chosen one. `voters` is tallyVotes'
// ({ optionId: [userId] }); `names` maps user id -> name.
export default function PollVoters({ poll, voters, names, userId, initialOption, onClose }) {
  useProfiles(); // pictures and names follow profile changes
  const [current, setCurrent] = useState(initialOption);
  const option = poll.options.find((o) => o.id === current) ?? poll.options[0];
  const who = voters[option.id] ?? [];

  return (
    <Modal title={poll.question} className="poll-voters-dialog" onClose={onClose}>
      <div className="poll-voters">
        <div className="poll-voters-tabs" role="tablist" aria-label={t('chat.pollDialog.answers')}>
          {poll.options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={o.id === option.id}
              className={`poll-voters-tab${o.id === option.id ? ' active' : ''}`}
              onClick={() => setCurrent(o.id)}
            >
              {o.emoji && <span className="poll-option-emoji"><ReactionEmoji native={o.emoji} /></span>}
              <span className="poll-voters-tab-text">{o.text}</span>
              <span className="poll-voters-tab-count">({voters[o.id]?.length ?? 0})</span>
            </button>
          ))}
        </div>
        <div className="poll-voters-list" role="tabpanel" aria-label={t('chat.pollVoters.votedFor', { answer: option.text })}>
          {who.length === 0 ? (
            <p className="vc-hint">{t('chat.pollVoters.none')}</p>
          ) : (
            <ul>
              {who.map((id) => {
                const name = id === userId
                  ? t('chat.pollVoters.you', { name: names?.[id] ?? t('chat.reactions.you') })
                  : names?.[id] ?? t('chat.reactions.someone');
                return (
                  <li key={id}>
                    <Avatar userId={id} alt="" className="poll-voter-avatar" />
                    <span>{name}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
