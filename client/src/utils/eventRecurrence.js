import { formatDayMonth, formatWeekday } from './dateFormat';
import { t } from '../i18n';

// Repeating events (server/eventRecurrence.js has the rules): the choices the event editor
// offers for a start time, as Discord does, and what a rule says in words. Rules are Discord's
// ({ frequency: 0 yearly, 1 monthly, 2 weekly, 3 daily, interval, by_weekday, by_n_weekday,
// by_month, by_month_day }), days 0 Monday ... 6 Sunday, on the device's time zone.

const NONE = { by_weekday: null, by_n_weekday: null, by_month: null, by_month_day: null };
const WEEKDAYS = [0, 1, 2, 3, 4];

// Discord's day number of a Date (0 Monday ... 6 Sunday).
export const weekdayOf = (date) => (date.getDay() + 6) % 7;

// Which of its weekday in the month the date is (1–5: the 2nd Tuesday...).
const nthOf = (date) => Math.ceil(date.getDate() / 7);

// The device's time zone, which the server lays occurrences on.
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// What the editor offers for an event starting at `date`: [{ key, rule, label }], 'none' first.
export function repeatChoices(date) {
  const weekday = weekdayOf(date);
  const day = formatWeekday(date);
  const nth = nthOf(date);
  const choices = [
    { key: 'none', rule: null, label: t('events.repeat.none') },
    { key: 'daily', rule: { frequency: 3, interval: 1, ...NONE }, label: t('events.repeat.daily') },
  ];
  if (weekday <= 4) {
    choices.push({ key: 'weekdays', rule: { frequency: 3, interval: 1, ...NONE, by_weekday: WEEKDAYS }, label: t('events.repeat.weekdays') });
  }
  choices.push(
    { key: 'weekly', rule: { frequency: 2, interval: 1, ...NONE, by_weekday: [weekday] }, label: t('events.repeat.weekly', { day }) },
    { key: 'fortnightly', rule: { frequency: 2, interval: 2, ...NONE, by_weekday: [weekday] }, label: t('events.repeat.fortnightly', { day }) },
    {
      key: 'monthly',
      rule: { frequency: 1, interval: 1, ...NONE, by_n_weekday: [{ n: nth, day: weekday }] },
      label: t('events.repeat.monthly', { nth: t(`events.repeat.nth.${nth}`), day }),
    },
    {
      key: 'yearly',
      rule: { frequency: 0, interval: 1, ...NONE, by_month: [date.getMonth() + 1], by_month_day: [date.getDate()] },
      label: t('events.repeat.yearly', { date: formatDayMonth(date) }),
    },
  );
  return choices;
}

// Which of repeatChoices a rule is ('none' for null, 'custom' for one the editor can't make,
// such as a bot's).
export function repeatKey(rule) {
  if (!rule) return 'none';
  if (rule.frequency === 3) {
    if (!rule.by_weekday) return 'daily';
    return rule.by_weekday.join() === WEEKDAYS.join() ? 'weekdays' : 'custom';
  }
  if (rule.frequency === 2) return rule.interval === 2 ? 'fortnightly' : 'weekly';
  if (rule.frequency === 1) return 'monthly';
  return 'yearly';
}

// The rule in words, for an occurrence at `date`: "Weekly on Tuesday".
export function describeRepeat(rule, date) {
  if (!rule) return null;
  const key = repeatKey(rule);
  return repeatChoices(date).find((c) => c.key === key)?.label ?? t('events.repeat.custom');
}

// The same kind of repeat for a new start date (the editor keeps "weekly" when the day
// changes); null if that date doesn't offer it (weekdays on a Saturday).
export function ruleFor(key, date) {
  return repeatChoices(date).find((c) => c.key === key)?.rule ?? null;
}
