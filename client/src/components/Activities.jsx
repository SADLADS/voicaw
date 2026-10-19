import React, { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { faPause, faPlay, faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../contexts';
import { useActivities } from '../hooks/useActivities';
import { useVoiceStreams } from '../hooks/useVoiceStreams';
import { t } from '../i18n';
import { activityHeading, activityIcon, activityImageUrl, activityName, activityParty, activityTime } from '../utils/activities';

// What someone's doing, as the profile card shows it (Discord's "Playing a game"): for each
// activity a heading, the game's picture (without one, its kind's icon: a gamepad, a note...),
// its name, what the game says (details; state with the party size) and the time played or
// left, ticking; a music player's playing / paused on the picture's corner (as Discord's small
// picture). A bot's custom status is just its text. First, sharing their screen in a guild
// voice channel you can see (StreamSection). Nothing without any.
export default function Activities({ userId }) {
  const activitiesOf = useActivities();
  const streamOf = useVoiceStreams();
  const stream = streamOf(userId);
  const activities = activitiesOf(userId);
  const timed = activities.some((a) => a.start || a.end);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timed) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);

  if (!activities.length && !stream) return null;
  return [
    stream && <StreamSection key="stream" stream={stream} />,
    ...activities.map((activity, i) => {
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
            <span className="activity-image-wrap">
              {image
                ? <img className="activity-image" src={image} alt="" title={activity.imageText ?? undefined} loading="lazy" />
                : <span className="activity-image activity-image-none" aria-hidden="true"><Icon icon={activityIcon(activity)} /></span>}
              {activity.smallIcon && <SmallIcon activity={activity} />}
            </span>
            <div className="activity-text">
              <div className="activity-name">{activityName(activity)}</div>
              {activity.details && <div>{activity.details}</div>}
              {(activity.state || party) && <div>{[activity.state, party].filter(Boolean).join(' ')}</div>}
              {time && <div>{time}</div>}
            </div>
          </div>
        </div>
      );
    }),
  ];
}

// Playing or paused, on the picture's bottom right corner.
function SmallIcon({ activity }) {
  const label = activity.smallText ?? t(activity.smallIcon === 'paused' ? 'activities.paused' : 'activities.playingNow');
  return (
    <span className={`activity-small-icon ${activity.smallIcon}`} title={label} role="img" aria-label={label}>
      <Icon icon={activity.smallIcon === 'paused' ? faPause : faPlay} />
    </span>
  );
}

// "Streaming in" a guild voice channel: the channel, its guild, and a link to it.
function StreamSection({ stream }) {
  const guilds = useContext(LayoutContext)?.guildList?.guilds ?? [];
  const guildName = guilds.find((g) => String(g.id) === stream.guildId)?.name;
  return (
    <div className="profile-card-section activity activity-stream">
      <div className="member-card-label">{t('activities.headingStreaming')}</div>
      <div className="activity-body">
        <span className="activity-image activity-image-none activity-image-live" aria-hidden="true"><Icon icon={faTowerBroadcast} /></span>
        <div className="activity-text">
          <div className="activity-name">{stream.channelName ?? t('activities.unknownChannel')}</div>
          {guildName && <div>{guildName}</div>}
          <Link className="activity-stream-link" to={`/guild/${stream.guildId}/${stream.channelId}`}>{t('activities.goToChannel')}</Link>
        </div>
      </div>
    </div>
  );
}
