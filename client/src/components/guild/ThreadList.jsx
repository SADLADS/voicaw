import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { fetchChannelThreads } from '../../services/guildService';
import { onGuildEvent } from '../../utils/ws-client';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, useProfiles } from '../../utils/profiles';
import { formatDateTime, useDateFormat } from '../../utils/dateFormat';

const MARGIN = 8;

// A text channel's threads, under the header's threads button (`anchor`, its rect) on a
// computer, over the whole screen on a phone: active ones, then archived, most recently active
// first, kept current by thread events. A click opens one (`onOpen(thread)`); with `canCreate`,
// Create starts one on its own (`onCreate`). Closes on Escape, a click elsewhere or ✕.
export default function ThreadList({ channel, anchor, isMobile, canCreate, onOpen, onCreate, onClose }) {
  useProfiles();
  useDateFormat();
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchChannelThreads(channel.id)
      .then((list) => { if (!cancelled) setThreads(list); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    const off = onGuildEvent((event) => {
      if (event.type === 'guild_thread_update' && event.thread.parent_id === channel.id) {
        setThreads((list) => {
          if (!list) return list;
          const old = list.find((t) => t.id === event.thread.id);
          const rest = list.filter((t) => t.id !== event.thread.id);
          return [{ ...event.thread, joined: old?.joined ?? false }, ...rest];
        });
      } else if (event.type === 'guild_thread_delete' && event.channelId === channel.id) {
        setThreads((list) => list?.filter((t) => t.id !== event.threadId));
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [channel.id]);

  useEffect(() => {
    const onDown = (e) => {
      // The header button toggles it itself.
      if (!e.target.closest?.('.threads-panel, .threads-button, .vc-dialog-backdrop')) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    if (!isMobile) {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('touchstart', onDown);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, isMobile]);

  const style = isMobile || !anchor ? undefined : {
    top: anchor.bottom + MARGIN,
    right: Math.max(MARGIN, window.innerWidth - anchor.right),
  };
  const active = threads?.filter((t) => !t.archived) ?? [];
  const archived = threads?.filter((t) => t.archived) ?? [];

  const row = (thread) => (
    <li key={thread.id}>
      <button type="button" className="thread-list-item" onClick={() => onOpen(thread)}>
        <span className="thread-list-name">{thread.name}</span>
        <span className="thread-list-meta">
          {displayName(thread.owner_id)} · {thread.message_count} {thread.message_count === 1 ? 'message' : 'messages'} ·{' '}
          {formatDateTime((thread.last_activity ?? thread.created_at) * 1000)}
          {thread.joined ? ' · Joined' : ''}
        </span>
      </button>
    </li>
  );

  return createPortal(
    <div className={`pins-panel threads-panel${isMobile ? ' mobile' : ''}`} style={style} role="dialog" aria-label="Threads">
      <div className="pins-panel-header">
        <FontAwesomeIcon icon={faComments} />
        <h5>Threads</h5>
        {canCreate && (
          <button type="button" className="btn btn-primary btn-sm vc-button threads-panel-create" onClick={onCreate}>
            <FontAwesomeIcon icon={faPlus} /> Create
          </button>
        )}
        <button type="button" className="icon-button pins-panel-close" aria-label="Close" onClick={onClose}>
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>
      <div className="pins-panel-list">
        {error && <p className="error-text pins-panel-note">{error}</p>}
        {threads === null && !error && <p className="pins-panel-note">Loading…</p>}
        {threads?.length === 0 && (
          <div className="pins-panel-empty">
            <p>#{channel.name} doesn&apos;t have any threads yet.</p>
            <p className="vc-hint">Start one from a message&apos;s menu{canCreate ? ', or with Create' : ''}.</p>
          </div>
        )}
        {active.length > 0 && (
          <>
            <h6 className="thread-list-heading">Active</h6>
            <ul className="thread-list">{active.map(row)}</ul>
          </>
        )}
        {archived.length > 0 && (
          <>
            <h6 className="thread-list-heading">Archived</h6>
            <ul className="thread-list">{archived.map(row)}</ul>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
