import React, { useEffect, useState } from 'react';
import { ReactionEmoji } from './MessageReactions';
import PollVoters from './PollVoters';
import ConfirmDialog from './guild/ConfirmDialog';
import { myVotes, pollEndsAt, tallyVotes, timeLeft, voteShare } from '../utils/pollMarkup';

// The current time (unix s), redrawn every minute until `endsAt` and once right at it. A new
// `endsAt` (the poll was just ended) takes a fresh reading at once, so it shows as closed
// straight away rather than at the next tick.
function useNowUntil(endsAt) {
  const [clock, setClock] = useState(() => ({ endsAt, now: Date.now() / 1000 }));
  if (clock.endsAt !== endsAt) setClock({ endsAt, now: Date.now() / 1000 });
  const { now } = clock;
  useEffect(() => {
    if (endsAt == null || now >= endsAt) return undefined;
    const wait = Math.min(endsAt - now, 60) * 1000;
    const timer = setTimeout(() => setClock({ endsAt, now: Date.now() / 1000 }), wait + 50);
    return () => clearTimeout(timer);
  }, [endsAt, now]);
  return now;
}

// A poll message (utils/pollMarkup.js), in two phases like Discord's:
// - voting: tapping answers only selects them (one, or several in a multiple-choice poll);
//   Vote sends the choice, Show results switches to the results without voting.
// - results (once you've voted, or asked to see them): each answer's share of the votes as a
//   bar; tapping one opens who voted (PollVoters). Remove vote takes yours back, or Back to
//   vote returns if you haven't voted.
// A poll runs for its duration from `sentAt` (the message's timestamp), or until its author
// ends it (`onEnd`, async; only given to the author); then it shows its final results and
// takes no more votes (votes timestamped after the end don't count).
// `onVote(optionIds)` (async) sets your vote ([]: removes it). Without it (not sent yet, keys
// not ready, the pinned list) the results are shown and nothing can be changed. `names` maps
// user id -> name, for who voted.
export default function Poll({ poll, reactions, userId, names, sentAt, onVote, onEnd }) {
  const endsAt = pollEndsAt(poll, sentAt);
  const now = useNowUntil(endsAt);
  const ended = Boolean(poll.endedAt) || (endsAt != null && now >= endsAt);
  const { voters, cast } = tallyVotes(poll, reactions, endsAt);
  const mine = myVotes(poll, reactions, userId, endsAt);
  const voted = mine.length > 0;
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  // The answer whose voters are shown (results phase).
  const [votersFor, setVotersFor] = useState(null);

  const results = voted || showResults || !onVote || ended;
  const canVote = Boolean(onVote) && !ended;
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
          const share = voteShare(who.length, cast);
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
              <span className="poll-count">{who.length} {who.length === 1 ? 'vote' : 'votes'} · {share}%</span>
            </button>
          );
        })}
      </div>
      <div className="poll-footer">
        <span className="poll-status">
          {cast} {cast === 1 ? 'vote' : 'votes'}
          {ended ? <> · <strong className="poll-closed">Poll closed</strong></> : endsAt != null ? ` · ${timeLeft(endsAt - now)}` : null}
        </span>
        {canVote && (
          <span className="poll-actions">
            {onEnd && (
              <button type="button" className="poll-link poll-end" onClick={(e) => { stop(e); setConfirmingEnd(true); }}>End poll</button>
            )}
            {!results && (
              <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(true); }}>Show results</button>
            )}
            {results && voted && (
              <button type="button" className="poll-link" disabled={busy} onClick={(e) => { stop(e); submit([]); }}>Remove vote</button>
            )}
            {results && !voted && (
              <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(false); }}>Back to vote</button>
            )}
          </span>
        )}
        {canVote && !results && (
          <button
            type="button"
            className="btn btn-primary btn-sm vc-button poll-vote"
            disabled={busy || choice.length === 0}
            onClick={(e) => { stop(e); submit(choice); }}
          >
            Vote
          </button>
        )}
      </div>
      {confirmingEnd && (
        <span onTouchStart={stop} onContextMenu={stop} onClick={stop}>
          <ConfirmDialog
            title="End poll"
            message="End this poll now? Nobody will be able to vote any more, and the results so far are final."
            confirmLabel="End poll"
            focusConfirm
            onConfirm={onEnd}
            onClose={() => setConfirmingEnd(false)}
          />
        </span>
      )}
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
