import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { faInbox } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import Avatar from './Avatar';
import { useInbox } from '../hooks/useInbox';
import { formatRelative } from '../utils/dateFormat';
import { t } from '../i18n';

// The desktop app's title bar's Inbox: what notified you over the last 30 days (useInbox),
// newest first, unread ones marked; clicking one opens its chat as its notification would.
export default function Inbox() {
  const [open, setOpen] = useState(false);
  const { entries, failed } = useInbox(open);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  let content;
  if (failed) content = <p className="inbox-empty">{t('app.inbox.failed')}</p>;
  else if (!entries) content = <p className="inbox-empty">{t('app.inbox.loading')}</p>;
  else if (!entries.length) content = <p className="inbox-empty">{t('app.inbox.empty')}</p>;
  else {
    content = (
      <ul className="inbox-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`inbox-entry${entry.unread ? ' unread' : ''}`}
              onClick={() => {
                setOpen(false);
                navigate(entry.url);
              }}
            >
              {entry.senderId
                ? <Avatar userId={entry.senderId} className="inbox-entry-icon" draggable={false} />
                : <img className="inbox-entry-icon" src={entry.icon} alt="" draggable={false} />}
              <span className="inbox-entry-text">
                <span className="inbox-entry-top">
                  <strong className="inbox-entry-title">{entry.title}</strong>
                  <time className="inbox-entry-time">{formatRelative(entry.timestamp)}</time>
                </span>
                <span className="inbox-entry-body">{entry.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="inbox" ref={ref}>
      <button
        type="button"
        className={`title-bar-button${open ? ' active' : ''}`}
        aria-label={t('app.inbox.title')}
        title={t('app.inbox.title')}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon icon={faInbox} />
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label={t('app.inbox.title')}>
          <h2 className="inbox-heading">{t('app.inbox.title')}</h2>
          {content}
        </div>
      )}
    </div>
  );
}
