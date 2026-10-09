// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import Activities from './Activities';
import ActivityLine from './ActivityLine';
import {
  activityHeading, activityLineKey, activityName, activityParty, activityTime, activityImageUrl,
  applyActivitiesSnapshot, applyUserActivities, resetActivities, activitiesOf,
} from '../utils/activities';
import i18n from '../i18n';

afterEach(() => {
  cleanup();
  resetActivities();
});

const hades = { name: 'Hades', type: 0, details: 'Tartarus', state: 'Heat 8', start: 1000, end: null, partySize: 1, partyMax: 4, imageText: 'Zagreus', image: 'a'.repeat(32) };

describe('activities (utils/activities.js)', () => {
  it('keeps a snapshot, then changes', () => {
    applyActivitiesSnapshot({ 1: [hades], 2: [] });
    expect(activitiesOf(1)).toEqual([hades]);
    expect(activitiesOf('2')).toEqual([]);
    applyUserActivities({ userId: '1', activities: [] });
    expect(activitiesOf(1)).toEqual([]);
  });

  it('words each kind, with a time and party size', () => {
    for (const type of [0, 1, 2, 3, 5, 9]) {
      expect(i18n.exists(activityLineKey({ type })), String(type)).toBe(true);
      expect(activityHeading({ type })).toBeTruthy();
    }
    expect(activityLineKey({ type: 4 })).toBeNull();
    expect(activityName({ name: null })).toBe('a game');
    expect(activityTime({ start: 0 + 1000 }, 1000 + 3723000)).toBe('1:02:03 elapsed');
    expect(activityTime({ start: 1000, end: 61000 }, 1000)).toBe('1:00 left');
    expect(activityTime({}, 5)).toBeNull();
    expect(activityParty(hades)).toBe('(1 of 4)');
    expect(activityParty({ partyMax: null })).toBeNull();
    expect(activityImageUrl('abc', 'https://api.example.com/api')).toBe('https://api.example.com/api/activity-images/abc');
    expect(activityImageUrl(null)).toBeNull();
  });
});

describe('showing activities', () => {
  it('draws one line for lists, and nothing without an activity', () => {
    const { container } = render(<ActivityLine userId="7" />);
    expect(container.textContent).toBe('');
    act(() => applyUserActivities({ userId: '7', activities: [hades] }));
    expect(container.textContent).toBe('Playing Hades');
    expect(container.querySelector('strong').textContent).toBe('Hades');
    act(() => applyUserActivities({ userId: '7', activities: [{ type: 4, state: 'Helping out' }] }));
    expect(container.textContent).toBe('Helping out');
  });

  it("draws the profile card's section, with a gamepad without a picture", () => {
    applyUserActivities({ userId: '8', activities: [hades, { ...hades, name: null, image: null, start: null, partyMax: null, type: 3, details: null, state: null }] });
    const { container } = render(<Activities userId="8" />);
    expect(screen.getByText('Playing a game')).toBeTruthy();
    expect(screen.getByText('Heat 8 (1 of 4)')).toBeTruthy();
    expect(screen.getByText(/elapsed$/)).toBeTruthy();
    expect(container.querySelector('img.activity-image').getAttribute('title')).toBe('Zagreus');
    expect(screen.getByText('Watching')).toBeTruthy();
    expect(screen.getByText('a game')).toBeTruthy();
    expect(container.querySelectorAll('.activity-image-none')).toHaveLength(1);
  });
});
