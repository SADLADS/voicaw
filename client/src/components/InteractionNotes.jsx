import React from 'react';
import { Trans } from 'react-i18next';
import Avatar from './Avatar';
import { displayName, useProfiles } from '../utils/profiles';
import { requestDismiss } from '../utils/botComponents';
import { dismissEphemeral } from '../services/interactionService';
import { t } from '../i18n';

// What a bot's interaction replies carry (server/interactions.js): the "<person> used /command"
// line above a command's answer, "<bot> is thinking…" while a reply is deferred, and the
// "Only you can see this" footer of an ephemeral message.

// Above a command's answer (message.interaction with a name): who used which command.
export function InteractionHeader({ interaction }) {
  useProfiles();
  if (!interaction?.name || !interaction.user_id) return null;
  const name = displayName(interaction.user_id);
  // Slash commands start with "/"; user and message commands are named as they are.
  const slash = !interaction.command_type || interaction.command_type === 1;
  return (
    // Drawn like a reply's snippet (the same line down to the avatar).
    <div className="reply-snippet interaction-header">
      <Avatar userId={interaction.user_id} alt="" className="reply-avatar" />
      <span className="reply-preview interaction-header-text">
        <Trans
          i18nKey={slash ? 'components.usedCommand' : 'components.usedApp'}
          values={{ name, command: interaction.name }}
          components={{ cmd: <span className="interaction-header-command" /> }}
        />
      </span>
    </div>
  );
}

// A deferred reply before the bot fills it in.
export function ThinkingLine({ botName }) {
  return (
    <div className="interaction-thinking" role="status">
      {t('components.thinking', { name: botName })}
      <span className="interaction-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
    </div>
  );
}

// Under an ephemeral message: only you see it (until you reload), and Dismiss hides it now.
export function EphemeralFooter({ messageId }) {
  return (
    <div className="ephemeral-footer">
      <span>{t('components.ephemeral')}</span>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        className="ephemeral-dismiss"
        onClick={(e) => {
          e.stopPropagation();
          requestDismiss(messageId);
          dismissEphemeral(messageId);
        }}
      >
        {t('components.dismiss')}
      </button>
    </div>
  );
}
