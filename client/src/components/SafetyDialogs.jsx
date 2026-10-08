import React from 'react';
import ConfirmDialog from './guild/ConfirmDialog';
import ReportDialog from './ReportDialog';
import { blockUser, blockWebhook } from '../utils/blocks';
import { removeFriend } from '../utils/friends';
import { banMember, kickMember, transferGuild } from '../services/guildService';
import { closeSafetyDialog, useSafetyDialog } from '../utils/safetyDialogs';
import { t } from '../i18n';

// What a right-click menu's item opened when it asks first (utils/safetyDialogs.js): Block,
// Report, and a person's menu's Remove Friend, Make Owner, Kick and Ban (utils/personMenu.js).
// Mounted once in App.
const GUILD_ACTIONS = {
  transfer: { run: transferGuild, title: 'guilds.memberList.transfer.title', message: 'guilds.memberList.transfer.message', confirm: 'guilds.memberList.transfer.confirm' },
  kick: { run: kickMember, title: 'guilds.memberList.kick.title', message: 'guilds.memberList.kick.message', confirm: 'guilds.memberList.kick.button' },
  ban: { run: banMember, title: 'guilds.memberList.ban.title', message: 'guilds.memberList.ban.message', confirm: 'guilds.memberList.ban.button' },
};

export default function SafetyDialogs() {
  const dialog = useSafetyDialog();
  if (!dialog) return null;
  const { kind, name, userId, guild } = dialog;
  if (kind === 'report') {
    return <ReportDialog target={{ kind: 'user', userId }} name={name} onClose={closeSafetyDialog} />;
  }
  if (kind === 'unfriend') {
    return (
      <ConfirmDialog
        title={t('friends.removeConfirmTitle', { name })}
        message={t('friends.removeConfirm')}
        confirmLabel={t('friends.remove')}
        onConfirm={() => removeFriend(userId)}
        onClose={closeSafetyDialog}
      />
    );
  }
  const guildAction = GUILD_ACTIONS[kind];
  if (guildAction) {
    return (
      <ConfirmDialog
        title={t(guildAction.title, { name })}
        message={t(guildAction.message, { name, guild: guild.name })}
        confirmLabel={t(guildAction.confirm)}
        onConfirm={() => guildAction.run(guild.id, userId)}
        onClose={closeSafetyDialog}
      />
    );
  }
  const webhook = kind === 'block-webhook';
  return (
    <ConfirmDialog
      title={t('chat.blocked.confirmTitle', { name })}
      message={webhook ? t('chat.blocked.confirmWebhook') : t('chat.blocked.confirm')}
      confirmLabel={webhook ? t('chat.blocked.blockWebhook') : t('chat.blocked.block')}
      onConfirm={() => (webhook ? blockWebhook(dialog.webhookId) : blockUser(userId))}
      onClose={closeSafetyDialog}
    />
  );
}
