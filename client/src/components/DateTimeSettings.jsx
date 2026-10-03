import React from 'react';
import { formatDate, formatDateTime, formatTime, setDateSettings, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

// Settings → Date & time: how dates and times are shown on this device (utils/dateFormat).
// Each option shows what it looks like, using the time now.
export default function DateTimeSettings() {
  const { date, time } = useDateFormat();
  const now = new Date();
  const dateLabel = (format, name) => t('settings.dateTime.option', { name, example: formatDate(now, { date: format }) });
  const timeLabel = (format, name) => t('settings.dateTime.option', { name, example: formatTime(now, { time: format }) });

  return (
    <div className="settings-card">
      <h5>{t('settings.dateTime.title')}</h5>
      <div className="date-time-settings">
        <label htmlFor="date-format">{t('settings.dateTime.dateFormat')}</label>
        <select id="date-format" value={date} onChange={(e) => setDateSettings({ date: e.target.value })}>
          <option value="auto">{dateLabel('auto', t('settings.dateTime.automatic'))}</option>
          <option value="dmy">{dateLabel('dmy', t('settings.dateTime.dmy'))}</option>
          <option value="mdy">{dateLabel('mdy', t('settings.dateTime.mdy'))}</option>
          <option value="ymd">{dateLabel('ymd', t('settings.dateTime.ymd'))}</option>
        </select>
        <label htmlFor="time-format">{t('settings.dateTime.timeFormat')}</label>
        <select id="time-format" value={time} onChange={(e) => setDateSettings({ time: e.target.value })}>
          <option value="auto">{timeLabel('auto', t('settings.dateTime.automatic'))}</option>
          <option value="12">{timeLabel('12', t('settings.dateTime.twelveHour'))}</option>
          <option value="24">{timeLabel('24', t('settings.dateTime.twentyFourHour'))}</option>
        </select>
      </div>
      <p className="vc-hint">{t('settings.dateTime.hint', { example: formatDateTime(now, { date, time }) })}</p>
    </div>
  );
}
