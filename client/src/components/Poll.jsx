import React from 'react';
import { tallyVotes } from '../utils/pollMarkup';

// A poll message (utils/pollMarkup.js): the question, then each answer with a bar showing its
// share of the votes. Tapping an answer votes for it (again: takes the vote back); in a
// single-choice poll it replaces your vote. Without `onVote` (not sent yet, keys not ready)
// the answers can't be tapped. `names` maps user id -> name, for who voted.
export default function Poll({ poll, reactions, userId, names, onVote }) {
  const { voters, total } = tallyVotes(poll, reactions);
  const most = Math.max(0, ...Object.values(voters).map((v) => v.length));

  return (
    <div className="poll" role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-question">{poll.question}</div>
      <div className="poll-kind">{poll.multi ? 'Select one or more answers' : 'Select one answer'}</div>
      <div className="poll-options">
        {poll.options.map((option) => {
          const who = voters[option.id];
          const mine = who.includes(userId);
          const share = total ? Math.round((who.length / total) * 100) : 0;
          const whoText = who.map((id) => (id === userId ? 'You' : names?.[id] ?? 'Someone')).join(', ');
          return (
            <button
              key={option.id}
              type="button"
              className={`poll-option${mine ? ' mine' : ''}${who.length > 0 && who.length === most ? ' leading' : ''}`}
              role={poll.multi ? 'checkbox' : 'radio'}
              aria-checked={mine}
              aria-label={`${option.text}: ${who.length} ${who.length === 1 ? 'vote' : 'votes'}`}
              title={who.length ? `Voted for by ${whoText}` : undefined}
              disabled={!onVote}
              onClick={(e) => { e.stopPropagation(); onVote(option.id); }}
            >
              <span className="poll-bar" style={{ width: `${share}%` }} aria-hidden="true" />
              <span className={`poll-check${poll.multi ? ' square' : ''}`} aria-hidden="true">{mine ? '✓' : ''}</span>
              <span className="poll-option-text">{option.text}</span>
              <span className="poll-count">{who.length > 0 ? `${who.length} · ${share}%` : ''}</span>
            </button>
          );
        })}
      </div>
      <div className="poll-footer">{total} {total === 1 ? 'vote' : 'votes'}</div>
    </div>
  );
}
