import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSquarePollHorizontal, faTrophy } from '@fortawesome/free-solid-svg-icons';
import { ReactionEmoji } from './MessageReactions';
import { parsePoll, pollEndFits, pollEndsAt, pollResult } from '../utils/pollMarkup';
import { displayName, useProfiles } from '../utils/profiles';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';

function Answer({ option }) {
  return (
    <strong className="poll-end-answer">
      {option.emoji && <span className="poll-option-emoji"><ReactionEmoji native={option.emoji} /></span>}
      {option.text}
    </strong>
  );
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
  const { total, winners, votes, share } = pollResult(poll, msg.poll_reactions, pollEndsAt(poll, msg.parent_timestamp));
  const author = displayName(msg.sender_id, msg.sender_username);

  let result;
  if (total === 0) result = 'Nobody voted.';
  else if (winners.length === 1) {
    result = <><Answer option={winners[0]} /> won with {share}% ({votes} of {total} {total === 1 ? 'vote' : 'votes'}).</>;
  } else {
    result = (
      <>
        It&apos;s a draw between {winners.map((o, i) => (
          <React.Fragment key={o.id}>{i > 0 && (i === winners.length - 1 ? ' and ' : ', ')}<Answer option={o} /></React.Fragment>
        ))}, {share}% each.
      </>
    );
  }

  return (
    <div className="poll-end" data-msg-id={msg.id} title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
      <FontAwesomeIcon icon={faSquarePollHorizontal} className="poll-end-icon" />
      <div className="poll-end-body">
        <div>
          <strong>{author}</strong>&apos;s poll <strong>{poll.question}</strong> has closed.
        </div>
        <div className="poll-end-result">
          {winners.length === 1 && <FontAwesomeIcon icon={faTrophy} className="poll-end-trophy" />}
          <span>{result}</span>
        </div>
        {onJump && (
          <button type="button" className="poll-link" onClick={() => onJump(msg.parent_message_id)}>View poll</button>
        )}
      </div>
    </div>
  );
}
