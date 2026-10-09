import React from 'react';
import { Trans } from 'react-i18next';
import { useActivities } from '../hooks/useActivities';
import { activityLineKey, activityName } from '../utils/activities';

const BOLD = { b: <strong /> };

// One line about what someone's doing ("Playing **Hades**"), from their latest activity (Rich
// Presence, utils/activities.js); a bot's custom status is just its text. Nothing without one.
export default function ActivityLine({ userId, className = '' }) {
  const activitiesOf = useActivities();
  const [activity] = activitiesOf(userId);
  if (!activity) return null;
  const key = activityLineKey(activity);
  return (
    <span className={`activity-line ${className}`.trim()}>
      {key ? <Trans i18nKey={key} values={{ name: activityName(activity) }} components={BOLD} /> : activity.state}
    </span>
  );
}
