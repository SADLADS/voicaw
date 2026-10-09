import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGamepad } from '@fortawesome/free-solid-svg-icons';
import { useActivities } from '../hooks/useActivities';
import { activityHeading, activityImageUrl, activityName, activityParty, activityTime } from '../utils/activities';

// What someone's doing, as the profile card shows it (Discord's "Playing a game"): for each
// activity a heading, the game's picture (a gamepad without one), its name, what the game says
// (details; state with the party size) and the time played or left, ticking. A bot's custom
// status is just its text. Nothing without any.
export default function Activities({ userId }) {
  const activitiesOf = useActivities();
  const activities = activitiesOf(userId);
  const timed = activities.some((a) => a.start || a.end);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timed) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);

  if (!activities.length) return null;
  return activities.map((activity, i) => {
    if (activity.type === 4) {
      return <p key={i} className="profile-card-section activity-custom">{activity.state}</p>;
    }
    const image = activityImageUrl(activity.image);
    const party = activityParty(activity);
    const time = activityTime(activity, now);
    return (
      <div key={i} className="profile-card-section activity">
        <div className="member-card-label">{activityHeading(activity)}</div>
        <div className="activity-body">
          {image
            ? <img className="activity-image" src={image} alt="" title={activity.imageText ?? undefined} loading="lazy" />
            : <span className="activity-image activity-image-none" aria-hidden="true"><FontAwesomeIcon icon={faGamepad} /></span>}
          <div className="activity-text">
            <div className="activity-name">{activityName(activity)}</div>
            {activity.details && <div>{activity.details}</div>}
            {(activity.state || party) && <div>{[activity.state, party].filter(Boolean).join(' ')}</div>}
            {time && <div>{time}</div>}
          </div>
        </div>
      </div>
    );
  });
}
