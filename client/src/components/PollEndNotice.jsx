import React from 'react';
import { Trans } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSquarePollHorizontal, faTrophy } from '@fortawesome/free-solid-svg-icons';
import { ReactionEmoji } from './MessageReactions';
import { parsePoll, pollEndFits, pollEndsAt, pollResult, pollWithAnswers } from '../utils/pollMarkup';
import { displayName, useProfiles } from '../utils/profiles';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

function Answer({ option }) {
  return (
    <strong className="poll-end-answer">
      {option.emoji && <span className="poll-option-emoji"><ReactionEmoji native={option.emoji} /></span>}
      {option.text}
    </strong>
  );
}

// "<answer> won with 60% (3 of 5 votes).", a plural (chat.pollEnd.won_one / _other). Kept in a
// constant because i18n/keys.test.js only recognises plurals in t() calls.
const WON_KEY = 'chat.pollEnd.won';

// The answers that drew: "A, B and C" (the separators are translations too).
function Answers({ options }) {
  return options.map((o, i) => (
    <React.Fragment key={o.id}>
      {i > 0 && (i === options.length - 1 ? t('chat.pollEnd.lastSeparator') : t('chat.pollEnd.separator'))}
      <Answer option={o} />
    </React.Fragment>
  ));
}

// A "poll ended" row (server pollTimers.js): whose poll closed, and its result: the winning
// answer and its share of the voters, a draw, or nobody voted. Worked out on this device from
// the poll (`parent_plaintext`) and its votes (`poll_reactions`), which come with the row.
// Nothing is shown if the poll can't be read here (deleted, or from before you joined a group)
// or the row doesn't fit the poll (see pollEndFits). `onJump(id)` scrolls to the poll.
export default function PollEndNotice({ msg, onJump }) {
  useProfiles();
  useDateFormat();
  const poll = parsePoll(msg.parent_plaintext);
  if (!poll || !pollEndFits(poll, msg.parent_timestamp, msg.timestamp)) return null;
  const endsAt = pollEndsAt(poll, msg.parent_timestamp);
  // The row's sender is the poll's author; added answers can win too.
  const full = pollWithAnswers(poll, msg.poll_reactions, msg.sender_id, endsAt);
  const { cast, winners, votes, share } = pollResult(full, msg.poll_reactions, endsAt);
  const author = displayName(msg.sender_id, msg.sender_username);

  let result;
  if (cast === 0) result = t('chat.pollEnd.nobodyVoted');
  else if (winners.length === 1) {
    result = <Trans i18nKey={WON_KEY} count={cast} values={{ share, votes, count: cast }} components={{ answer: <Answer option={winners[0]} /> }} />;
  } else {
    result = <Trans i18nKey="chat.pollEnd.draw" values={{ share }} components={{ answers: <Answers options={winners} /> }} />;
  }

  return (
    <div className="poll-end" data-msg-id={msg.id} title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
      <FontAwesomeIcon icon={faSquarePollHorizontal} className="poll-end-icon" />
      <div className="poll-end-body">
        <div>
          <Trans i18nKey="chat.pollEnd.closed" values={{ author, question: poll.question }} components={{ b: <strong /> }} />
        </div>
        <div className="poll-end-result">
          {winners.length === 1 && <FontAwesomeIcon icon={faTrophy} className="poll-end-trophy" />}
          <span>{result}</span>
        </div>
        {onJump && (
          <button type="button" className="poll-link" onClick={() => onJump(msg.parent_message_id)}>{t('chat.pollEnd.view')}</button>
        )}
      </div>
    </div>
  );
}
