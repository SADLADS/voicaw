import React, { useEffect, useState } from 'react';
import { ReactionEmoji } from './MessageReactions';
import PollVoters from './PollVoters';
import ConfirmDialog from './guild/ConfirmDialog';
import {
  MAX_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  answerProblem,
  canRemoveAnswer,
  myVotes,
  pollEndsAt,
  pollWithAnswers,
  tallyVotes,
  timeLeft,
  voteShare,
} from '../utils/pollMarkup';
import { t } from '../i18n';

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
// In an open poll anyone can add answers while voting (`onAddAnswer(text)`, async), neither
// voted for nor ticked; each says who added it (not the poll's author, `authorId`). An
// added answer nobody else has voted for has a ✕ (on the vote screen only) for its creator, the
// author and, in a guild, moderators (`canModerate`, not the author's answers):
// `onRemoveAnswer(option)`, async, after asking.
export default function Poll({ poll: message, reactions, userId, authorId, names, sentAt, onVote, onEnd, onAddAnswer, onRemoveAnswer, canModerate = false }) {
  const endsAt = pollEndsAt(message, sentAt);
  const now = useNowUntil(endsAt);
  const ended = Boolean(message.endedAt) || (endsAt != null && now >= endsAt);
  // The poll with the answers people added.
  const poll = pollWithAnswers(message, reactions, authorId, endsAt);
  const { voters, cast } = tallyVotes(poll, reactions, endsAt);
  const mine = myVotes(poll, reactions, userId, endsAt);
  const voted = mine.length > 0;
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  // The answer whose voters are shown (results phase).
  const [votersFor, setVotersFor] = useState(null);
  // The answer being typed in (an open poll), and why it can't be added.
  const [newAnswer, setNewAnswer] = useState('');
  const [answerError, setAnswerError] = useState(null);
  // The added answer the "Remove answer?" dialog is asking about.
  const [removing, setRemoving] = useState(null);

  const results = voted || showResults || !onVote || ended;
  const canVote = Boolean(onVote) && !ended;
  const canAdd = canVote && !results && poll.open && Boolean(onAddAnswer) && poll.options.length < MAX_POLL_OPTIONS;
  // Only while voting, like adding: not on the results (Remove vote first).
  const removable = (option) => canVote && !results && Boolean(onRemoveAnswer) &&
    canRemoveAnswer(option, { userId, authorId, canModerate, voters });
  // "added by Sam", for answers added by someone other than the poll's author.
  const addedBy = (option) => option.addedBy && option.addedBy !== authorId && (
    <span className="poll-option-by">
      {option.addedBy === userId
        ? t('chat.poll.addedByYou')
        : t('chat.poll.addedBy', { name: names?.[option.addedBy] ?? t('chat.reactions.someone') })}
    </span>
  );
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

  async function addAnswer(e) {
    e.preventDefault();
    e.stopPropagation();
    const problem = answerProblem(poll, newAnswer);
    if (problem) return setAnswerError(problem);
    setBusy(true);
    try {
      // Not ticked (it would look voted for): it's picked like any other answer.
      await onAddAnswer(newAnswer);
      setNewAnswer('');
      setAnswerError(null);
    } catch (err) {
      setAnswerError(err.response?.data?.error || err.message || t('chat.poll.addAnswerFailed'));
    } finally {
      setBusy(false);
    }
  }

  const stop = (e) => e.stopPropagation(); // not the message's own click handling

  // An added answer's ✕ (its row's last part, outside the answer's own button).
  const removeButton = (option) => removable(option) && (
    <button
      type="button"
      className="poll-option-remove"
      aria-label={t('chat.poll.removeAnswerOf', { answer: option.text })}
      title={t('chat.poll.removeAnswer')}
      disabled={busy}
      onClick={(e) => { stop(e); setRemoving(option); }}
    >
      ×
    </button>
  );

  return (
    <div className="poll" role="group" aria-label={t('chat.poll.label', { question: poll.question })}>
      <div className="poll-question">{poll.question}</div>
      <div className="poll-kind">
        {poll.multi ? t('chat.poll.selectMany') : t('chat.poll.selectOne')}
        {poll.open && ` · ${t('chat.poll.openHint')}`}
      </div>
      <div className="poll-options" role={results ? undefined : poll.multi ? 'group' : 'radiogroup'}>
        {poll.options.map((option) => {
          const emoji = option.emoji && <span className="poll-option-emoji"><ReactionEmoji native={option.emoji} /></span>;
          if (!results) {
            const on = choice.includes(option.id);
            return (
              <div key={option.id} className="poll-option-row">
                <button
                  type="button"
                  className={`poll-option${on ? ' selected' : ''}`}
                  role={poll.multi ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={busy}
                  onClick={(e) => { stop(e); toggle(option.id); }}
                >
                  <span className={`poll-check${poll.multi ? ' square' : ''}`} aria-hidden="true">{on ? '✓' : ''}</span>
                  {emoji}
                  <span className="poll-option-text">{option.text}{addedBy(option)}</span>
                </button>
                {removeButton(option)}
              </div>
            );
          }
          const who = voters[option.id];
          const share = voteShare(who.length, cast);
          const isMine = mine.includes(option.id);
          return (
            <div key={option.id} className="poll-option-row">
              <button
                type="button"
                className={`poll-option result${isMine ? ' mine' : ''}${who.length > 0 && who.length === most ? ' leading' : ''}`}
                aria-label={isMine
                  ? t('chat.poll.optionLabelMine', { answer: option.text, count: who.length })
                  : t('chat.poll.optionLabel', { answer: option.text, count: who.length })}
                onClick={(e) => { stop(e); setVotersFor(option.id); }}
              >
                <span className="poll-bar" style={{ width: `${share}%` }} aria-hidden="true" />
                {emoji}
                <span className="poll-option-text">{option.text}{addedBy(option)}</span>
                {isMine && <span className="poll-mine-mark" title={t('chat.poll.yourVote')} aria-hidden="true">✓</span>}
                <span className="poll-count">{t('chat.poll.optionCount', { count: who.length, share })}</span>
              </button>
            </div>
          );
        })}
      </div>
      {canAdd && (
        <form className="poll-add-answer" onSubmit={addAnswer} onClick={stop} onKeyDown={stop}>
          <input
            className="form-control form-control-sm"
            aria-label={t('chat.poll.addAnswerLabel')}
            placeholder={t('chat.poll.addAnswerPlaceholder')}
            maxLength={MAX_OPTION_LENGTH}
            value={newAnswer}
            disabled={busy}
            onChange={(e) => { setNewAnswer(e.target.value); setAnswerError(null); }}
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !newAnswer.trim()}>
            {t('chat.poll.addAnswer')}
          </button>
          {answerError && <p className="error-msg poll-add-error" role="alert">{answerError}</p>}
        </form>
      )}
      <div className="poll-footer">
        <span className="poll-status">
          {t('chat.poll.votes', { count: cast })}
          {ended ? <> · <strong className="poll-closed">{t('chat.poll.closed')}</strong></> : endsAt != null ? ` · ${timeLeft(endsAt - now)}` : null}
        </span>
        {canVote && (
          <span className="poll-actions">
            {onEnd && (
              <button type="button" className="poll-link poll-end" onClick={(e) => { stop(e); setConfirmingEnd(true); }}>{t('chat.poll.end')}</button>
            )}
            {!results && (
              <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(true); }}>{t('chat.poll.showResults')}</button>
            )}
            {results && voted && (
              <button type="button" className="poll-link" disabled={busy} onClick={(e) => { stop(e); submit([]); }}>{t('chat.poll.removeVote')}</button>
            )}
            {results && !voted && (
              <button type="button" className="poll-link" onClick={(e) => { stop(e); setShowResults(false); }}>{t('chat.poll.backToVote')}</button>
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
            {t('chat.poll.vote')}
          </button>
        )}
      </div>
      {confirmingEnd && (
        <span onTouchStart={stop} onContextMenu={stop} onClick={stop}>
          <ConfirmDialog
            title={t('chat.poll.end')}
            message={t('chat.poll.endConfirm')}
            confirmLabel={t('chat.poll.end')}
            focusConfirm
            onConfirm={onEnd}
            onClose={() => setConfirmingEnd(false)}
          />
        </span>
      )}
      {removing && (
        <span onTouchStart={stop} onContextMenu={stop} onClick={stop}>
          <ConfirmDialog
            title={t('chat.poll.removeAnswer')}
            message={t('chat.poll.removeAnswerConfirm', { answer: removing.text })}
            confirmLabel={t('common.remove')}
            focusConfirm
            onConfirm={() => onRemoveAnswer(removing)}
            onClose={() => setRemoving(null)}
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
