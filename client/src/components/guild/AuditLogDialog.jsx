import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import Avatar from '../Avatar';
import ConfirmDialog from './ConfirmDialog';
import { clearAuditLog, fetchAuditLog, fetchMembers } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDateTime, useDateFormat } from '../../utils/dateFormat';
import { displayName, mergeProfiles, useProfiles } from '../../utils/profiles';
import { AUDIT_FILTERS, CLEAR_CHOICES, describeEntry, entryChanges } from '../../utils/auditLog';

// The guild's audit log (View Audit Log; server/auditLog.js): who did what, newest first,
// filtered by who did it and what kind of thing, a page at a time. Entries about channels you
// can't see aren't sent. Clicking an entry with details opens what changed. Entries are kept
// for good; the owner can clear old ones (asks first; the clear is logged).
export default function AuditLogDialog({ guild, user, onClose }) {
  useProfiles();
  useDateFormat();
  const [members, setMembers] = useState([]);
  const [userId, setUserId] = useState('');
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState(null);
  const [webhooks, setWebhooks] = useState(new Map());
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [clearAge, setClearAge] = useState(90);
  const [confirmClear, setConfirmClear] = useState(false);
  const request = useRef(0);
  const isOwner = guild.owner === user?.id;

  useEffect(() => {
    fetchMembers(guild.id).then((list) => {
      mergeProfiles(list);
      setMembers(list);
    }).catch(() => {});
  }, [guild.id]);

  const load = useCallback(async (before) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const actions = AUDIT_FILTERS.find((f) => f.key === filter)?.actions;
      const page = await fetchAuditLog(guild.id, { before, actions, userId: userId || undefined });
      if (id !== request.current) return;
      mergeProfiles(page.users);
      setWebhooks((prev) => new Map([...(before ? prev : []), ...page.webhooks.map((w) => [w.id, w.name])]));
      setEntries((prev) => (before ? [...(prev ?? []), ...page.entries] : page.entries));
      setNext(page.next);
    } catch (err) {
      if (id === request.current) setError(errorMessage(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [guild.id, filter, userId]);

  useEffect(() => {
    setEntries(null);
    setOpen(new Set());
    load();
  }, [load]);

  const names = {
    user: (id) => displayName(id, 'Someone'),
    webhook: (id, fallback) => webhooks.get(id) ?? fallback,
  };

  function toggle(id) {
    setOpen((prev) => {
      const nextOpen = new Set(prev);
      if (nextOpen.has(id)) nextOpen.delete(id);
      else nextOpen.add(id);
      return nextOpen;
    });
  }

  return (
    <Modal title="Audit Log" onClose={onClose} className="audit-log-dialog">
      <div className="audit-log-filters">
        <label>
          <span className="vc-label">Who</span>
          <select className="form-select form-control" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Filter by member">
            <option value="">Everyone</option>
            {[...members]
              .sort((a, b) => displayName(a.id, a.username).localeCompare(displayName(b.id, b.username)))
              .map((m) => <option key={m.id} value={m.id}>{displayName(m.id, m.username)}</option>)}
          </select>
        </label>
        <label>
          <span className="vc-label">What</span>
          <select className="form-select form-control" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by action">
            <option value="">All actions</option>
            {AUDIT_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="error-msg" role="alert">{error}</p>}
      {entries == null && !error && <p className="vc-hint">Loading…</p>}
      {entries?.length === 0 && <p className="vc-hint">Nothing here yet.</p>}

      {entries?.length > 0 && (
        <ul className="audit-log-list">
          {entries.map((entry) => {
            const changes = entryChanges(entry);
            if (entry.action === 'message_delete' && entry.details?.sentAt) {
              changes.push(`Sent ${formatDateTime(entry.details.sentAt * 1000)}`);
            }
            const expanded = open.has(entry.id);
            const Row = changes.length ? 'button' : 'div';
            return (
              <li key={entry.id} className={`audit-log-entry${expanded ? ' expanded' : ''}`} data-action={entry.action} data-actor={entry.actor_id ?? ''}>
                <Row
                  {...(changes.length ? { type: 'button', 'aria-expanded': expanded, onClick: () => toggle(entry.id) } : {})}
                  className="audit-log-row"
                >
                  <Avatar userId={entry.actor_id} className="audit-log-avatar" />
                  <span className="audit-log-text">
                    <span className="audit-log-summary">
                      {describeEntry(entry, names).map((part, i) => (typeof part === 'string'
                        ? <React.Fragment key={i}>{part}</React.Fragment>
                        : <strong key={i}>{part.name}</strong>))}
                    </span>
                    <span className="audit-log-time">{formatDateTime(entry.created_at * 1000)}</span>
                  </span>
                  {changes.length > 0 && <span className="audit-log-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
                </Row>
                {expanded && (
                  <ul className="audit-log-changes">
                    {changes.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {next != null && (
        <button type="button" className="btn btn-outline-secondary btn-sm audit-log-more" disabled={loading} onClick={() => load(next)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
      <p className="vc-hint audit-log-note">Deleted messages&apos; text isn&apos;t kept.</p>

      {isOwner && (
        <div className="audit-log-clear">
          <span className="vc-label">Clear old entries</span>
          <div className="vc-form-row">
            <select className="form-select form-control" value={clearAge} onChange={(e) => setClearAge(Number(e.target.value))} aria-label="Entries to clear">
              {CLEAR_CHOICES.map(([days, label]) => <option key={days} value={days}>{label}</option>)}
            </select>
            <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => setConfirmClear(true)}>Clear</button>
          </div>
          <p className="vc-hint">Only you, the owner, can do this. Everyone who can see the log will see that you did.</p>
        </div>
      )}
      {confirmClear && (
        <ConfirmDialog
          title="Clear audit log"
          message={clearAge
            ? `Delete every audit log entry ${CLEAR_CHOICES.find(([d]) => d === clearAge)[1].toLowerCase()}? This can't be undone.`
            : "Delete the whole audit log? This can't be undone."}
          confirmLabel="Clear"
          onConfirm={async () => {
            await clearAuditLog(guild.id, clearAge);
            load();
          }}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </Modal>
  );
}
