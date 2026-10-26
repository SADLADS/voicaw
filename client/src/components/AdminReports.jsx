import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from './guild/ConfirmDialog';
import {
  deleteReportedMessage, dismissReport, fetchReports, suspendUser,
} from '../services/reportService';
import { liftAccountSuspension } from '../utils/adminUsers';
import { onReportsChanged } from '../utils/ws-client';
import { errorMessage } from '../utils/guildDisplay';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

const who = (name, username) => (name && name !== username ? `${name} (@${username})` : `@${username}`);

// Where a report's message was, in words (and a link for a guild's).
function Place({ report }) {
  if (report.place === 'guild') {
    return (
      <Link to={`/guild/${report.guild_id}/${report.channel_id}`}>
        {t('settings.reports.inGuild', { guild: report.guild_name ?? '?', channel: report.channel_name ?? '?' })}
      </Link>
    );
  }
  if (report.place === 'dm') return t('settings.reports.inDm');
  if (report.place === 'group') return t('settings.reports.inGroup');
  return t('settings.reports.aPerson');
}

// One open report and what can be done about it.
function Report({ report, onSuspend, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const act = (run) => async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <li className="admin-report">
      <div className="admin-report-head">
        <strong>{t(`chat.report.categories.${report.category}`)}</strong>
        <span className="vc-hint">{formatDateTime(report.created_at * 1000)}</span>
      </div>
      <div>
        {t('settings.reports.reported')}{' '}
        <strong>{who(report.reported_display_name, report.reported_username)}</strong>
        {report.reported_suspended_at ? ` · ${t('settings.reports.alreadySuspended')}` : ''}
      </div>
      <div className="vc-hint">
        {t('settings.reports.by', { name: who(report.reporter_display_name, report.reporter_username) })} · <Place report={report} />
      </div>
      {report.kind === 'message' && (
        report.content != null ? (
          <blockquote className="admin-report-content">
            {report.shared ? <div className="vc-hint">{t('settings.reports.sharedByReporter')}</div> : null}
            {report.content || t('settings.reports.noText')}
          </blockquote>
        ) : (
          <p className="vc-hint">{t('settings.reports.notShared')}</p>
        )
      )}
      {report.note && <p className="admin-report-note">{t('settings.reports.note', { note: report.note })}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
      <div className="admin-report-actions">
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={act(() => dismissReport(report.id))}>
          {t('settings.reports.dismiss')}
        </button>
        {report.place === 'guild' && (
          <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={act(() => deleteReportedMessage(report.id))}>
            {t('settings.reports.deleteMessage')}
          </button>
        )}
        {!report.reported_suspended_at && (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => onSuspend(report)}>
            {t('settings.reports.suspend')}
          </button>
        )}
      </div>
    </li>
  );
}

// Settings → Admin → Reports (global admins): open reports, suspended accounts, and what was
// done lately (server/routes/reports.js). Updates itself when a report comes in.
export default function AdminReports() {
  useDateFormat();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [suspending, setSuspending] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    fetchReports().then((d) => { setData(d); setError(null); }, (err) => setError(errorMessage(err)));
  }, []);
  useEffect(() => {
    load();
    return onReportsChanged(load);
  }, [load]);

  if (!data) return <div className="settings-card"><h5>{t('settings.reports.title')}</h5>{error && <p className="error-msg">{error}</p>}</div>;
  return (
    <div className="settings-card admin-reports">
      <h5>{t('settings.reports.title')}</h5>
      <p className="vc-hint">{t('settings.reports.hint')}</p>
      {data.open.length === 0 ? (
        <p className="vc-hint">{t('settings.reports.none')}</p>
      ) : (
        <ul className="admin-report-list">
          {data.open.map((report) => (
            <Report key={report.id} report={report} onChanged={load} onSuspend={(r) => { setReason(''); setSuspending(r); }} />
          ))}
        </ul>
      )}

      <h6 id="settings-suspended" className="mt-3">{t('settings.reports.suspendedTitle')}</h6>
      {data.suspended.length === 0 ? (
        <p className="vc-hint">{t('settings.reports.noneSuspended')}</p>
      ) : (
        <ul className="admin-suspended-list">
          {data.suspended.map((u) => (
            <li key={u.id}>
              <span>
                <strong>{who(u.display_name, u.username)}</strong>
                <span className="vc-hint"> · {formatDateTime(u.suspended_at * 1000)}{u.suspended_reason ? ` · ${u.suspended_reason}` : ''}</span>
              </span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => liftAccountSuspension(u.id).then(load, (err) => setError(errorMessage(err)))}>
                {t('settings.reports.lift')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.resolved.length > 0 && (
        <details className="mt-3">
          <summary>{t('settings.reports.resolvedTitle')}</summary>
          <ul className="admin-resolved-list">
            {data.resolved.map((r) => (
              <li key={r.id} className="vc-hint">
                {formatDateTime(r.resolved_at * 1000)} · {t(`chat.report.categories.${r.category}`)} ·{' '}
                {who(r.reported_display_name, r.reported_username)} · {t(`settings.reports.actions.${r.action}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}

      {suspending && (
        <ConfirmDialog
          title={t('settings.reports.suspendTitle', { name: who(suspending.reported_display_name, suspending.reported_username) })}
          message={t('settings.reports.suspendMessage')}
          confirmLabel={t('settings.reports.suspend')}
          onConfirm={async () => {
            await suspendUser(suspending.reported_id, reason.trim(), suspending.id);
            load();
          }}
          onClose={() => setSuspending(null)}
        >
          <label className="admin-suspend-reason">
            {t('settings.reports.reason')}
            <textarea className="form-control" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}
