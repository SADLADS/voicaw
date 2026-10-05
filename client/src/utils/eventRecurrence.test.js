import { describe, it, expect } from 'vitest';
import { describeRepeat, repeatChoices, repeatKey, ruleFor, weekdayOf } from './eventRecurrence';
import { eventFromUrl } from './inviteLinks';
import { fromInputs, toInputs } from './eventDisplay';

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

  it('turns date and time inputs into unix seconds and back', () => {
    const at = fromInputs('2026-10-20', '20:15');
    expect(at).toBe(Math.floor(new Date(2026, 9, 20, 20, 15).getTime() / 1000));
    expect(toInputs(at)).toEqual({ date: '2026-10-20', time: '20:15' });
    expect(fromInputs('', '20:15')).toBeNull();
  });
});
