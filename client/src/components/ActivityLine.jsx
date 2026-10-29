import React from 'react';
import { Trans } from 'react-i18next';
import { Icon } from './Icon';
import { faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { useActivities } from '../hooks/useActivities';
import { useVoiceStreams } from '../hooks/useVoiceStreams';
import { activityIcon, activityLineKey, activityName, activityStatusText } from '../utils/activities';
import { t } from '../i18n';

const BOLD = { b: <strong /> };

// One line about what someone's doing ("🎮 Playing **Hades**", its kind's icon first), from their
// latest activity (Rich Presence, utils/activities.js); a bot's custom status is just its text,
// and so is the artist or song a music player chose to show instead (activityStatusText).
// Sharing their screen in a guild voice channel you can see comes first, as in Discord:
// "Streaming in **lounge**" (utils/voiceStreams.js). Nothing without either.
export default function ActivityLine({ userId, className = '' }) {
  const activitiesOf = useActivities();
  const streamOf = useVoiceStreams();
  const stream = streamOf(userId);
  const [activity] = activitiesOf(userId);
  if (stream) {
    return (
      <span className={`activity-line activity-line-live ${className}`.trim()}>
        <Icon icon={faTowerBroadcast} className="activity-line-icon" aria-hidden="true" />
        <Trans i18nKey="activities.streamingIn" values={{ channel: stream.channelName ?? t('activities.unknownChannel') }} components={BOLD} />
      </span>
    );
  }
  if (!activity) return null;
  const key = activityLineKey(activity);
  const icon = activityIcon(activity);
  const statusText = activityStatusText(activity);
  return (
    <span className={`activity-line ${className}`.trim()}>
      {icon && <Icon icon={icon} className="activity-line-icon" aria-hidden="true" />}
      {statusText ? <strong>{statusText}</strong>
        : key ? <Trans i18nKey={key} values={{ name: activityName(activity) }} components={BOLD} /> : activity.state}
    </span>
  );
}
