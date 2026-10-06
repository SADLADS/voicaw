import React from 'react';
import ConfirmDialog from './guild/ConfirmDialog';
import ReportDialog from './ReportDialog';
import { blockUser, blockWebhook } from '../utils/blocks';
import { closeSafetyDialog, useSafetyDialog } from '../utils/safetyDialogs';
import { t } from '../i18n';

// What a right-click menu's Block or Report opened (utils/safetyDialogs.js): blocking asks
// first, as on a profile card. Mounted once in App.
export default function SafetyDialogs() {
  const dialog = useSafetyDialog();
  if (!dialog) return null;
  if (dialog.kind === 'report') {
    return <ReportDialog target={{ kind: 'user', userId: dialog.userId }} name={dialog.name} onClose={closeSafetyDialog} />;
  }
  const webhook = dialog.kind === 'block-webhook';
  return (
    <ConfirmDialog
      title={t('chat.blocked.confirmTitle', { name: dialog.name })}
      message={webhook ? t('chat.blocked.confirmWebhook') : t('chat.blocked.confirm')}
      confirmLabel={webhook ? t('chat.blocked.blockWebhook') : t('chat.blocked.block')}
      onConfirm={() => (webhook ? blockWebhook(dialog.webhookId) : blockUser(dialog.userId))}
      onClose={closeSafetyDialog}
    />
  );
}
