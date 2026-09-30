import React, { useState } from 'react';
import { ReactionEmoji } from './MessageReactions';
import PollVoters from './PollVoters';
import { myVotes, tallyVotes } from '../utils/pollMarkup';

// A poll message (utils/pollMarkup.js), in two phases like Discord's:
// - voting: tapping answers only selects them (one, or several in a multiple-choice poll);
//   Vote sends the choice, Show results switches to the results without voting.
// - results (once you've voted, or asked to see them): each answer's share of the votes as a
//   bar; tapping one opens who voted (PollVoters). Remove vote takes yours back, or Back to
//   vote returns if you haven't voted.
// `onVote(optionIds)` (async) sets your vote ([]: removes it). Without it (not sent yet, keys
// not ready, the pinned list) the results are shown and nothing can be changed. `names` maps
// user id -> name, for who voted.
export default function Poll({ poll, reactions, userId, names, onVote }) {
  const { voters, total } = tallyVotes(poll, reactions);
  const mine = myVotes(poll, reactions, userId);
  const voted = mine.length > 0;
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  // The answer whose voters are shown (results phase).
  const [votersFor, setVotersFor] = useState(null);

  const results = voted || showResults || !onVote;
  const most = Math.max(0, ...Object.values(voters).map((v) => v.length));
  // Answers that were edited away drop out of the selection.
  const choice = selected.filter((id) => voters[id]);

  function toggle(optionId) {
    if (poll.multi) setSelected(choice.includes(optionId) ? choice.filter((id) => id !== optionId) : [...choice, optionId]);
    else setSelected(choice.includes(optionId) ? [] : [optionId]);
  }

  async function submit(optionIds) {
    setBusy(true);
    try {
      await onVote(optionIds);
      setSelected([]);
      setShowResults(false);
    } catch {
      // Already reported (the composer's error line); the choice stays for another try.
    } finally {
      setBusy(false);
    }
  }

  const stop = (e) => e.stopPropagation(); // not the message's own click handling

  return (
    <div className="poll" role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-question">{poll.question}</div>
      <div className="poll-kind">{poll.multi ? 'Select one or more answers' : 'Select one answer'}</div>
      <div className="poll-options" role={results ? undefined : poll.multi ? 'group' : 'radiogroup'}>
        {poll.options.map((option) => {
          const emoji = option.emoji && <span className="poll-option-emoji"><ReactionEmoji native={option.emoji} /></span>;
          if (!results) {
            const on = choice.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className={`poll-option${on ? ' selected' : ''}`}
                role={poll.multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                disabled={busy}
                onClick={(e) => { stop(e); toggle(option.id); }}
              >
                <span className={`poll-check${poll.multi ? ' square' : ''}`} aria-hidden="true">{on ? '✓' : ''}</span>
                {emoji}
                <span className="poll-option-text">{option.text}</span>
              </button>
            );
          }
          const who = voters[option.id];
          const share = total ? Math.round((who.length / total) * 100) : 0;
          const isMine = mine.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`poll-option result${isMine ? ' mine' : ''}${who.length > 0 && who.length === most ? ' leading' : ''}`}
              aria-label={`${option.text}: ${who.length} ${who.length === 1 ? 'vote' : 'votes'}${isMine ? ', your vote' : ''}. Show who voted`}
              onClick={(e) => { stop(e); setVotersFor(option.id); }}
            >
              <span className="poll-bar" style={{ width: `${share}%` }} aria-hidden="true" />
              {emoji}
              <span className="poll-option-text">{option.text}</span>
              {isMine && <span className="poll-mine-mark" title="Your vote" aria-hidden="true">✓</span>}
              <span className="poll-count">{who.length} · {share}%</span>
            </button>
          );
        })}
      </div>
      <div className="poll-footer">
        <span>{total} {total === 1 ? 'vote' : 'votes'}</span>
        {onVote && (
          <span className="poll-actions">
            {!results && (
              <>
                <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(true); }}>Show results</button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm vc-button poll-vote"
                  disabled={busy || choice.length === 0}
                  onClick={(e) => { stop(e); submit(choice); }}
                >
                  Vote
                </button>
              </>
            )}
            {results && voted && (
              <button type="button" className="poll-link" disabled={busy} onClick={(e) => { stop(e); submit([]); }}>Remove vote</button>
            )}
            {results && !voted && (
              <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(false); }}>Back to vote</button>
            )}
          </span>
        )}
      </div>
      {votersFor && (
        // It's portalled out of the message, but React still passes its events up to the
        // message: a long press in it mustn't open the message's actions.
        <span onTouchStart={stop} onContextMenu={stop} onClick={stop}>
          <PollVoters
            poll={poll}
            voters={voters}
            names={names}
            userId={userId}
            initialOption={votersFor}
            onClose={() => setVotersFor(null)}
          />
        </span>
      )}
    </div>
  );
}
