import React from 'react';
import { Trans } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useActivities } from '../hooks/useActivities';
import { activityIcon, activityLineKey, activityName } from '../utils/activities';

const BOLD = { b: <strong /> };

// One line about what someone's doing ("🎮 Playing **Hades**", its kind's icon first), from their
// latest activity (Rich Presence, utils/activities.js); a bot's custom status is just its text.
// Nothing without one.
export default function ActivityLine({ userId, className = '' }) {
  const activitiesOf = useActivities();
  const [activity] = activitiesOf(userId);
  if (!activity) return null;
  const key = activityLineKey(activity);
  const icon = activityIcon(activity);
  return (
    <span className={`activity-line ${className}`.trim()}>
      {icon && <FontAwesomeIcon icon={icon} className="activity-line-icon" aria-hidden="true" />}
      {key ? <Trans i18nKey={key} values={{ name: activityName(activity) }} components={BOLD} /> : activity.state}
    </span>
  );
}
