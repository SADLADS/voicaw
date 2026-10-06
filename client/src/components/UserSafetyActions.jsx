import React, { useState } from 'react';
import ConfirmDialog from './guild/ConfirmDialog';
import ReportDialog from './ReportDialog';
import { blockUser, unblockUser, useBlocked } from '../utils/blocks';
import { useAuth } from '../hooks/useAuth';
import { t } from '../i18n';

// Block / Unblock and Report for someone else (a profile card, a guild member card). Blocking
// asks first. A blocked bot can't message you (server/botDms.js); it stays in its guilds.
export default function UserSafetyActions({ userId, name }) {
  const { user } = useAuth() ?? {};
  const blocked = useBlocked().has(Number(userId));
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  if (!user || userId == null || Number(userId) === Number(user.id)) return null;

  return (
    <div className="user-safety-actions">
      {blocked ? (
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => unblockUser(userId).catch(() => {})}>
          {t('chat.blocked.unblock')}
        </button>
      ) : (
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setConfirming(true)}>
          {t('chat.blocked.block')}
        </button>
      )}
      <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => setReporting(true)}>
        {t('chat.report.menuUser')}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t('chat.blocked.confirmTitle', { name })}
          message={t('chat.blocked.confirm')}
          confirmLabel={t('chat.blocked.block')}
          onConfirm={() => blockUser(userId)}
          onClose={() => setConfirming(false)}
        />
      )}
      {reporting && <ReportDialog target={{ kind: 'user', userId }} name={name} onClose={() => setReporting(false)} />}
    </div>
  );
}
