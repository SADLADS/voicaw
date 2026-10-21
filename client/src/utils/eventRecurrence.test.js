import { describe, it, expect } from 'vitest';
import { describeRepeat, interestedIn, repeatChoices, repeatKey, ruleFor, weekdayOf } from './eventRecurrence';
import { eventFromUrl } from './inviteLinks';
import { fromInputs, interestAfter, interestChoices, interestContinued, interestKept, toInputs } from './eventDisplay';

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

describe('interest in occurrences', () => {
  const rule = { frequency: 2, interval: 1, by_weekday: [1] };
  const series = { id: 1, recurrence: rule, occurrence_start: 100, interested: true, interested_all: true, my_occurrences: {}, revision: 0 };

  it('offers this one or all of them, for the occurrence shown', () => {
    expect(interestChoices({ ...series, original_start: 200, interested: false })).toEqual([
      { key: 'thisAdd', interested: true, occurrence: 200 },
      { key: 'allRemove', interested: false, occurrence: null },
    ]);
  });

  it('works out the choice as the server does', () => {
    const notSecond = interestAfter(series, { interested: false, occurrence: 200 });
    expect(notSecond).toEqual({ interested: true, interested_all: true, my_occurrences: { 200: false } });
    const notNow = interestAfter({ ...series, ...notSecond }, { interested: false, occurrence: 100 });
    expect(notNow).toEqual({ interested: false, interested_all: true, my_occurrences: { 200: false, 100: false } });
    // Back as the series is: no single one left for it. All of them replaces them all.
    expect(interestAfter({ ...series, ...notNow }, { interested: true, occurrence: 200 }).my_occurrences).toEqual({ 100: false });
    expect(interestAfter({ ...series, ...notNow }, { interested: true, occurrence: null })).toEqual({ interested: true, interested_all: true, my_occurrences: {} });
    // One that doesn't repeat is a plain toggle.
    expect(interestAfter({ id: 2, recurrence: null }, { interested: true, occurrence: null })).toEqual({ interested: true, interested_all: true, my_occurrences: {} });
  });

  it('keeps single ones still to come when the series is sent again, unless it was edited anew', () => {
    const before = { ...series, my_occurrences: { 100: false, 200: true } };
    expect(interestKept(before, { ...series, occurrence_start: 200 })).toEqual({ interested: true, interested_all: true, my_occurrences: { 200: true } });
    expect(interestKept(before, { ...series, revision: 1 })).toEqual({ interested: true, interested_all: true, my_occurrences: {} });
    expect(interestKept(null, { ...series, creator_id: 5 }, 5)).toEqual({ interested: true, interested_all: true, my_occurrences: {} });
  });

  it('carries interest over to the event "this and following" made', () => {
    const old = { ...series, interested_all: false, until: 300, my_occurrences: { 300: true, 400: false } };
    expect(interestContinued(old, { ...series, occurrence_start: 300 })).toEqual({ interested: true, interested_all: false, my_occurrences: { 300: true, 400: false } });
    expect(interestContinued(old, { ...series, occurrence_start: 310 })).toEqual({ interested: false, interested_all: false, my_occurrences: {} });
  });

  it('knows your interest in any occurrence', () => {
    const mine = { ...series, interested_all: false, interested: false, my_occurrences: { 200: true } };
    expect([interestedIn(mine, 100), interestedIn(mine, 200), interestedIn(mine, 300)]).toEqual([false, true, false]);
  });
});
