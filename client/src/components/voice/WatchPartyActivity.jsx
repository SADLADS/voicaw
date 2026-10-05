import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { formatClock, useWatchPartyLog } from '../../voice/watchParty';
import { formatTime, useDateFormat } from '../../utils/dateFormat';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const ACTIONS = new Set(['add', 'remove', 'move', 'play', 'pause', 'seek', 'skip', 'ended']);

// One entry as a sentence: "alice skipped Me at the zoo".
function describe(entry) {
  return t(`voice.watchParty.activity.${entry.action}`, {
    name: entry.user_id == null ? '' : displayName(entry.user_id),
    title: entry.title ?? t('voice.watchParty.untitled'),
    from: formatClock(entry.from),
    to: entry.action === 'move' ? entry.to : formatClock(entry.to),
  });
}

// Watch Together's activity log (voice/watchParty.js; the server keeps the last 100 in memory):
// who added, removed or moved videos, played, paused, jumped or skipped, newest first. Folded
// up it shows the latest; open, all of them.
export default function WatchPartyActivity({ channelId }) {
  useProfiles();
  useDateFormat(); // redraws the times when Settings → Date & time changes
  const entries = useWatchPartyLog(channelId).filter((e) => ACTIONS.has(e.action));
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  const newest = [...entries].reverse();

  return (
    <div className={`watch-party-activity${open ? ' open' : ''}`}>
      <button type="button" className="watch-party-activity-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} fixedWidth />
        <span className="watch-party-label">{t('voice.watchParty.activity.title', { count: entries.length })}</span>
        {!open && <span className="watch-party-activity-latest">{describe(newest[0])}</span>}
      </button>
      {open && (
        <ol className="watch-party-activity-list">
          {newest.map((entry) => (
            <li key={entry.id} className="watch-party-activity-entry">
              <span className="watch-party-activity-text">{describe(entry)}</span>
              <time className="watch-party-activity-time" dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at, { seconds: true })}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
