import React from 'react';
import { formatDate, formatDateTime, formatTime, setDateSettings, useDateFormat } from '../utils/dateFormat';

// Settings → Date & time: how dates and times are shown on this device (utils/dateFormat).
// Each option shows what it looks like, using the time now.
export default function DateTimeSettings() {
  const { date, time } = useDateFormat();
  const now = new Date();
  const dateLabel = (format, name) => `${name} (${formatDate(now, { date: format })})`;
  const timeLabel = (format, name) => `${name} (${formatTime(now, { time: format })})`;

  return (
    <div className="settings-card">
      <h5>Date &amp; time</h5>
      <div className="date-time-settings">
        <label htmlFor="date-format">Date format</label>
        <select id="date-format" value={date} onChange={(e) => setDateSettings({ date: e.target.value })}>
          <option value="auto">{dateLabel('auto', 'Automatic')}</option>
          <option value="dmy">{dateLabel('dmy', 'Day/month/year')}</option>
          <option value="mdy">{dateLabel('mdy', 'Month/day/year')}</option>
          <option value="ymd">{dateLabel('ymd', 'Year-month-day')}</option>
        </select>
        <label htmlFor="time-format">Time format</label>
        <select id="time-format" value={time} onChange={(e) => setDateSettings({ time: e.target.value })}>
          <option value="auto">{timeLabel('auto', 'Automatic')}</option>
          <option value="12">{timeLabel('12', '12-hour')}</option>
          <option value="24">{timeLabel('24', '24-hour')}</option>
        </select>
      </div>
      <p className="vc-hint">Messages will show: {formatDateTime(now, { date, time })}. Automatic follows your browser&apos;s language (British English if it has none). Saved on this device.</p>
    </div>
  );
}
