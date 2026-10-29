// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Activities from './Activities';
import ActivityLine from './ActivityLine';
import {
  activityHeading, activityLineKey, activityLineName, activityName, activityParty, activityTime, activityImageUrl,
  applyActivitiesSnapshot, applyUserActivities, resetActivities, activitiesOf,
} from '../utils/activities';
import i18n from '../i18n';
import {
  applyStreamVoiceState, removeGuildStreams, resetVoiceStreams, setGuildStreams, setStreamsFromLayout, streamOf,
} from '../utils/voiceStreams';
import { LayoutContext } from '../contexts';

afterEach(() => {
  cleanup();
  resetActivities();
  resetVoiceStreams();
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
    expect(activityLineName({ name: 'Feishin', state: 'Butthole Surfers', statusShows: 'state' })).toBe('Butthole Surfers');
    expect(activityLineName({ name: 'Feishin', details: 'Pepper', statusShows: 'details' })).toBe('Pepper');
    expect(activityLineName({ name: 'Feishin', state: null, statusShows: 'state' })).toBe('Feishin');
    expect(activityLineName({ name: 'Feishin', state: 'Butthole Surfers' })).toBe('Feishin');
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
    expect(container.querySelector('svg').getAttribute('data-icon')).toBe('gamepad');
    act(() => applyUserActivities({ userId: '7', activities: [{ ...hades, type: 2, name: 'Feishin' }] }));
    expect(container.textContent).toBe('Listening to Feishin');
    expect(container.querySelector('svg').getAttribute('data-icon')).toBe('music');
    act(() => applyUserActivities({ userId: '7', activities: [{ type: 4, state: 'Helping out' }] }));
    expect(container.textContent).toBe('Helping out');
    expect(container.querySelector('svg')).toBeNull();
  });

  it("draws the profile card's section, with its kind's icon without a picture", () => {
    applyUserActivities({ userId: '8', activities: [hades, { ...hades, name: null, image: null, start: null, partyMax: null, type: 3, details: null, state: null }] });
    const { container } = render(<Activities userId="8" />);
    expect(screen.getByText('Playing a game')).toBeTruthy();
    expect(screen.getByText('Heat 8 (1 of 4)')).toBeTruthy();
    expect(screen.getByText(/elapsed$/)).toBeTruthy();
    expect(container.querySelector('img.activity-image').getAttribute('title')).toBe('Zagreus');
    expect(screen.getByText('Watching')).toBeTruthy();
    expect(screen.getByText('a game')).toBeTruthy();
    expect(container.querySelectorAll('.activity-image-none')).toHaveLength(1);
    expect(container.querySelector('.activity-image-none svg').getAttribute('data-icon')).toBe('tv');
    expect(container.querySelector('.activity-small-icon')).toBeNull();
  });

  it("puts a music player's playing / paused on the picture's corner", () => {
    applyUserActivities({ userId: '10', activities: [{ ...hades, type: 2, smallIcon: 'paused', smallText: 'Paused' }, { ...hades, smallIcon: 'playing', smallText: null }] });
    const { container } = render(<Activities userId="10" />);
    const [paused, playing] = container.querySelectorAll('.activity-small-icon');
    expect(paused.getAttribute('title')).toBe('Paused');
    expect(paused.querySelector('svg').getAttribute('data-icon')).toBe('pause');
    expect(playing.getAttribute('aria-label')).toBe('Playing');
    expect(playing.querySelector('svg').getAttribute('data-icon')).toBe('play');
  });
});

describe('streaming in guild voice (utils/voiceStreams.js)', () => {
  it('follows the guild list, layouts and voice events', () => {
    setGuildStreams(1, [{ user_id: 5, channel_id: 10, channel_name: 'lounge' }]);
    expect(streamOf(5)).toEqual({ guildId: '1', channelId: '10', channelName: 'lounge' });
    // Stopped sharing, then sharing again elsewhere (the event carries the channel's name).
    applyStreamVoiceState({ guildId: 1, channelId: 10, userId: 5, state: { self_stream: false } });
    expect(streamOf(5)).toBeNull();
    applyStreamVoiceState({ guildId: 1, channelId: 11, channelName: 'gaming', userId: 5, state: { self_stream: true } });
    expect(streamOf(5)).toMatchObject({ channelId: '11', channelName: 'gaming' });
    // Leaving another guild's channel doesn't end it; leaving this one does.
    applyStreamVoiceState({ guildId: 2, channelId: 20, userId: 5, state: null });
    expect(streamOf(5)).not.toBeNull();
    applyStreamVoiceState({ guildId: 1, channelId: 11, userId: 5, state: null });
    expect(streamOf(5)).toBeNull();
    // A layout (what you can see) replaces the guild's; leaving the guild forgets them.
    setStreamsFromLayout({ id: 1, channels: [{ id: 12, name: 'stage', voice: [{ user_id: 6, self_stream: true }, { user_id: 7, self_stream: false }] }] });
    expect(streamOf(6)).toMatchObject({ channelName: 'stage' });
    expect(streamOf(7)).toBeNull();
    removeGuildStreams(1);
    expect(streamOf(6)).toBeNull();
  });

  it('comes first in the line and on the card, linking to the channel', () => {
    applyUserActivities({ userId: '9', activities: [hades] });
    setGuildStreams(3, [{ user_id: 9, channel_id: 30, channel_name: 'lounge' }]);
    const line = render(<ActivityLine userId="9" />);
    expect(line.container.textContent).toBe('Streaming in lounge');
    expect(line.container.querySelector('svg').getAttribute('data-icon')).toBe('tower-broadcast');
    line.unmount();
    const { container } = render(
      <MemoryRouter>
        <LayoutContext.Provider value={{ guildList: { guilds: [{ id: 3, name: 'Gamers' }] } }}>
          <Activities userId="9" />
        </LayoutContext.Provider>
      </MemoryRouter>
    );
    const sections = [...container.querySelectorAll('.activity')];
    expect(sections.map((s) => s.querySelector('.member-card-label').textContent)).toEqual(['Streaming', 'Playing a game']);
    expect(sections[0].textContent).toContain('lounge');
    expect(sections[0].textContent).toContain('Gamers');
    expect(sections[0].querySelector('a').getAttribute('href')).toBe('/guild/3/30');
  });
});
