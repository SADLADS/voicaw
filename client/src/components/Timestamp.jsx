import React from 'react';
import { useDateFormat } from '../utils/dateFormat';
import { formatTimestamp, useTimestampText } from '../utils/timestamps';

// A timestamp in a message (`<t:unix:style>`, see utils/timestamps): the time in the reader's
// time zone and date format, a relative one ("in 8 hours") kept up to date, and the full date
// and time on hover, as in Discord.
export default function Timestamp({ unix, style }) {
  useDateFormat();
  const text = useTimestampText(unix, style);
  const date = new Date(Number(unix) * 1000);
  return (
    <time className="timestamp" dateTime={date.toISOString()} title={formatTimestamp(unix, 'F')}>
      {text}
    </time>
  );
}
