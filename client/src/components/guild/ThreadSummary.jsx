import React, { useContext } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments } from '@fortawesome/free-solid-svg-icons';
import { ThreadContext } from '../../contexts';
import { displayName, useProfiles } from '../../utils/profiles';
import { formatDateTime, useDateFormat } from '../../utils/dateFormat';

// Under a message a thread started from (`thread`, server threads.js): its name, how many
// messages it has and when it was last active (or that it's archived). Opens the thread.
export function ThreadSummary({ thread }) {
  useDateFormat();
  const threads = useContext(ThreadContext);
  const count = thread.message_count;
  return (
    <button
      type="button"
      className="thread-summary"
      onClick={() => threads?.openThread(thread.id)}
      disabled={!threads}
    >
      <FontAwesomeIcon icon={faComments} className="thread-summary-icon" />
      <span className="thread-summary-name">{thread.name}</span>
      <span className="thread-summary-count">{count === 0 ? 'No messages yet' : `${count} ${count === 1 ? 'message' : 'messages'}`}</span>
      <span className="thread-summary-when">
        {thread.archived ? 'Archived' : formatDateTime((thread.last_activity ?? thread.created_at) * 1000)}
      </span>
    </button>
  );
}

// A "started a thread" row (system 'thread', for a thread started on its own): who started
// which thread, with its summary, and a way to the channel's other threads.
export function ThreadStartNotice({ msg }) {
  useProfiles();
  const threads = useContext(ThreadContext);
  const name = msg.thread?.name ?? msg.content;
  return (
    <div className="message-system thread-start-notice" data-msg-id={msg.id}>
      <p>
        <FontAwesomeIcon icon={faComments} /> <strong>{displayName(msg.sender_id, msg.sender_username)}</strong> started a thread:{' '}
        <strong>{name}</strong>.{' '}
        {threads && <button type="button" className="thread-start-link" onClick={threads.showThreads}>See all threads</button>}
      </p>
      {msg.thread && <ThreadSummary thread={msg.thread} />}
    </div>
  );
}
