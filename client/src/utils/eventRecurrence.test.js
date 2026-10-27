import { describe, it, expect } from 'vitest';
import { describeRepeat, repeatChoices, repeatKey, rsvpTo, ruleFor, weekdayOf } from './eventRecurrence';
import { eventFromUrl } from './inviteLinks';
import { fromInputs, rsvpAfter, rsvpContinued, rsvpKept, rsvpSummary, toInputs } from './eventDisplay';

describe('repeating events', () => {
  // Tuesday 20 October 2026, 20:00 on this machine: the third Tuesday.
  const tuesday = new Date(2026, 9, 20, 20, 0);

  it("offers Discord's choices for the start day", () => {
    const choices = repeatChoices(tuesday);
    expect(choices.map((c) => c.key)).toEqual(['none', 'daily', 'weekdays', 'weekly', 'fortnightly', 'monthly', 'yearly']);
    expect(weekdayOf(tuesday)).toBe(1);
    expect(ruleFor('weekly', tuesday)).toMatchObject({ frequency: 2, interval: 1, by_weekday: [1] });
    expect(ruleFor('fortnightly', tuesday)).toMatchObject({ frequency: 2, interval: 2, by_weekday: [1] });
    expect(ruleFor('monthly', tuesday)).toMatchObject({ frequency: 1, by_n_weekday: [{ n: 3, day: 1 }] });
    expect(ruleFor('yearly', tuesday)).toMatchObject({ frequency: 0, by_month: [10], by_month_day: [20] });
    expect(ruleFor('weekdays', tuesday).by_weekday).toEqual([0, 1, 2, 3, 4]);
    expect(choices.find((c) => c.key === 'monthly').label).toBe('Monthly on the third Tuesday');
  });

  it("doesn't offer weekdays only from a weekend", () => {
    const saturday = new Date(2026, 9, 24, 10, 0);
    expect(repeatChoices(saturday).some((c) => c.key === 'weekdays')).toBe(false);
    expect(ruleFor('weekdays', saturday)).toBeNull();
  });

  it('names rules, including ones the editor cannot make', () => {
    expect(repeatKey(null)).toBe('none');
    expect(repeatKey(ruleFor('fortnightly', tuesday))).toBe('fortnightly');
    expect(repeatKey({ frequency: 3, interval: 1, by_weekday: [4, 5] })).toBe('custom');
    expect(describeRepeat(ruleFor('weekly', tuesday), tuesday)).toBe('Weekly on Tuesday');
    expect(describeRepeat({ frequency: 3, interval: 1, by_weekday: [4, 5] }, tuesday)).toBe('Repeats');
  });
});

describe('event links and times', () => {
  it('finds the guild and event in a link', () => {
    expect(eventFromUrl('https://app.voicaw.com/guild/5?event=70')).toEqual({ guildId: 5, eventId: 70 });
    expect(eventFromUrl('https://voicaw.com/guild/5/10?event=70')).toEqual({ guildId: 5, eventId: 70 });
    expect(eventFromUrl('https://example.com/guild/5?event=70')).toBeNull();
    expect(eventFromUrl('https://app.voicaw.com/guild/5')).toBeNull();
  });

  it('finds the date of a repeating event in a link', () => {
    expect(eventFromUrl('https://app.voicaw.com/guild/5?event=70&on=2026-10-27')).toEqual({ guildId: 5, eventId: 70, on: '2026-10-27' });
    expect(eventFromUrl('https://app.voicaw.com/guild/5?event=70&on=soon')).toEqual({ guildId: 5, eventId: 70 });
  });

  it('turns date and time inputs into unix seconds and back', () => {
    const at = fromInputs('2026-10-20', '20:15');
    expect(at).toBe(Math.floor(new Date(2026, 9, 20, 20, 15).getTime() / 1000));
    expect(toInputs(at)).toEqual({ date: '2026-10-20', time: '20:15' });
    expect(fromInputs('', '20:15')).toBeNull();
  });
});

describe('RSVPs to occurrences', () => {
  const rule = { frequency: 2, interval: 1, by_weekday: [1] };
  const series = { id: 1, recurrence: rule, occurrence_start: 100, rsvp: 'going', rsvp_all: 'going', my_rsvps: {}, revision: 0 };

  it('works out an RSVP as the server does', () => {
    const notSecond = rsvpAfter(series, { rsvp: 'declined', occurrence: 200 });
    expect(notSecond).toEqual({ rsvp: 'going', rsvp_all: 'going', my_rsvps: { 200: 'declined' }, interested: true });
    const noneNow = rsvpAfter({ ...series, ...notSecond }, { rsvp: null, occurrence: 100 });
    expect(noneNow).toEqual({ rsvp: null, rsvp_all: 'going', my_rsvps: { 200: 'declined', 100: null }, interested: false });
    // Back as the series is: no single one left for it. All of them replaces them all.
    expect(rsvpAfter({ ...series, ...noneNow }, { rsvp: 'going', occurrence: 200 }).my_rsvps).toEqual({ 100: null });
    expect(rsvpAfter({ ...series, ...noneNow }, { rsvp: 'maybe', occurrence: null })).toEqual({ rsvp: 'maybe', rsvp_all: 'maybe', my_rsvps: {}, interested: true });
    // One that doesn't repeat has one answer.
    expect(rsvpAfter({ id: 2, recurrence: null }, { rsvp: 'declined', occurrence: null })).toEqual({ rsvp: 'declined', rsvp_all: 'declined', my_rsvps: {}, interested: false });
  });

  it('keeps single answers still to come when the series is sent again, unless it was edited anew', () => {
    const before = { ...series, my_rsvps: { 100: null, 200: 'maybe' } };
    expect(rsvpKept(before, { ...series, occurrence_start: 200 })).toEqual({ rsvp: 'maybe', rsvp_all: 'going', my_rsvps: { 200: 'maybe' }, interested: true });
    expect(rsvpKept(before, { ...series, revision: 1 })).toEqual({ rsvp: 'going', rsvp_all: 'going', my_rsvps: {}, interested: true });
    expect(rsvpKept(null, { ...series, creator_id: 5 }, 5)).toEqual({ rsvp: 'going', rsvp_all: 'going', my_rsvps: {}, interested: true });
    expect(rsvpKept(null, { ...series, creator_id: 5 }, 6)).toEqual({ rsvp: null, rsvp_all: null, my_rsvps: {}, interested: false });
  });

  it('carries answers over to the event "this and following" made', () => {
    const old = { ...series, rsvp_all: null, until: 300, my_rsvps: { 300: 'going', 400: 'declined' } };
    expect(rsvpContinued(old, { ...series, occurrence_start: 300 })).toEqual({ rsvp: 'going', rsvp_all: null, my_rsvps: { 300: 'going', 400: 'declined' }, interested: true });
    expect(rsvpContinued(old, { ...series, occurrence_start: 310 })).toEqual({ rsvp: null, rsvp_all: null, my_rsvps: {}, interested: false });
  });

  it('knows your answer to any occurrence', () => {
    const mine = { ...series, rsvp_all: 'maybe', rsvp: 'maybe', my_rsvps: { 200: 'declined', 300: null } };
    expect([rsvpTo(mine, 100), rsvpTo(mine, 200), rsvpTo(mine, 300), rsvpTo(mine, 400)]).toEqual(['maybe', 'declined', null, 'maybe']);
  });

  it('says how many answered', () => {
    expect(rsvpSummary({ user_count: 3, rsvp_counts: { going: 2, maybe: 1, declined: 4, waitlisted: 0 } })).toBe('2 going · 1 maybe');
    expect(rsvpSummary({ rsvp_limit: 2, rsvp_counts: { going: 2, maybe: 0, declined: 0, waitlisted: 3 } })).toBe('2 of 2 going · 3 on the waitlist');
    // What took place keeps only how many were interested.
    expect(rsvpSummary({ user_count: 5 })).toBe('5 interested');
  });
});
