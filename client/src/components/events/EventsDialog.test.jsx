// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('../../services/guildService', () => ({
  cancelEvent: vi.fn(), endEvent: vi.fn(), fetchEventUsers: vi.fn(async () => []), setEventInterest: vi.fn(async () => {}),
  skipOccurrence: vi.fn(), startEvent: vi.fn(),
}));
vi.mock('../MessageList', () => ({ MessageContent: ({ msg }) => <p>{msg.plaintext}</p> }));

import EventsDialog from './EventsDialog';
import { setEventInterest } from '../../services/guildService';
import { ConfigContext, InteractionContext } from '../../contexts';
import { addDays, dayKey, monthKey, startAtHour, startOnDay, weekDays } from '../../utils/eventCalendar';

const CREATE_EVENTS = 1 << 27;
const guild = { id: 5, my_permissions: 1 | CREATE_EVENTS, channels: [] };
const user = { id: 1 };

// An event somewhere else, `days` from now at 18:00, repeating weekly.
function eventIn(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(18, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  return {
    id: 7, guild_id: 5, creator_id: 1, name: 'Board games', entity_type: 'external', location: 'The pub', status: 'scheduled',
    start_time: start, end_time: start + 3600, occurrence_start: start, duration: 3600, user_count: 1, interested: true,
    recurrence: { frequency: 2, interval: 1, by_weekday: [(d.getDay() + 6) % 7], by_n_weekday: null, by_month: null, by_month_day: null },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// The dialog with its view kept, as GuildSidebar does.
function Harness({ events, onCreate, onOpenEvent = vi.fn(), setInterested = vi.fn(), myGuild = guild }) {
  const now = new Date();
  const [view, setView] = useState({ tab: 'calendar', month: monthKey(now), day: dayKey(now) });
  return (
    <ConfigContext.Provider value={{ s3Endpoint: '' }}>
      <InteractionContext.Provider value={{ isMobile: false }}>
        <EventsDialog
          guild={myGuild}
          user={user}
          events={events}
          loaded
          setInterested={setInterested}
          eventId={null}
          view={view}
          onView={(changes) => setView((v) => ({ ...v, ...changes }))}
          onOpenEvent={onOpenEvent}
          onCreate={onCreate}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('EventsDialog', () => {
  it('has the list and the calendar in tabs', () => {
    const onOpenEvent = vi.fn();
    render(<Harness events={[eventIn(2)]} onCreate={vi.fn()} onOpenEvent={onOpenEvent} />);
    // Calendar first, and open.
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Month', 'Week', 'Events']);
    expect(screen.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('grid')).toBeTruthy();
    // Weekly: on its day and a week later (both are within this page's six weeks).
    const chips = screen.getAllByRole('button', { name: /Board games/ }).filter((b) => b.classList.contains('event-calendar-chip'));
    expect(chips.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(chips[0]);
    expect(onOpenEvent).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByText('The pub')).toBeTruthy();
  });

  it('creates an event on a day of the calendar', () => {
    const onCreate = vi.fn();
    render(<Harness events={[]} onCreate={onCreate} />);
    const now = new Date();
    const later = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
    const cell = document.querySelector(`[data-day="${dayKey(later)}"]`);
    fireEvent.click(within(cell).getByRole('button', { name: /^Create an event on/ }));
    expect(onCreate).toHaveBeenCalledWith(startOnDay(dayKey(later)));
    // The chosen day's own button does the same.
    fireEvent.click(within(screen.getByRole('region', { name: "The day's events" })).getByRole('button', { name: 'Create Event' }));
    expect(onCreate).toHaveBeenLastCalledWith(startOnDay(dayKey(later)));
    // No making events on days that are over.
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const past = document.querySelector(`[data-day="${dayKey(yesterday)}"]`);
    if (past) expect(within(past).queryByRole('button', { name: /^Create an event on/ })).toBeNull();
  });

  it('shows a week of hours, and makes events on them', () => {
    const onCreate = vi.fn();
    const onOpenEvent = vi.fn();
    render(<Harness events={[eventIn(0)]} onCreate={onCreate} onOpenEvent={onOpenEvent} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Week' }));
    const today = dayKey(new Date());
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(document.querySelector('.event-week-day.today')).toBeTruthy();
    const block = screen.getByRole('button', { name: /Board games/ });
    expect(block).toHaveStyle({ top: `${18 * 44}px` });
    fireEvent.click(block);
    expect(onOpenEvent).toHaveBeenCalledWith(7);
    expect(onCreate).not.toHaveBeenCalled();
    // Next week: the weekly event again, and a click on an hour (here its first) makes one then.
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByRole('button', { name: /Board games/ })).toBeTruthy();
    expect(document.querySelector('.event-week-day.today')).toBeNull();
    const column = screen.getAllByRole('gridcell').find((cell) => cell.classList.contains('event-week-column'));
    fireEvent.click(column, { clientY: 0 });
    const monday = dayKey(weekDays(addDays(today, 7))[0]);
    expect(onCreate).toHaveBeenCalledWith(startAtHour(monday, 0));
    // Back to the month, on that week.
    fireEvent.click(screen.getByRole('tab', { name: 'Month' }));
    expect(document.querySelector('.event-calendar-cell.selected').dataset.day).toBe(monday);
  });

  it("offers no creating to those who can't make events", () => {
    render(<Harness events={[]} onCreate={vi.fn()} myGuild={{ ...guild, my_permissions: 1 }} />);
    expect(screen.queryByRole('button', { name: /Create an event/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.queryByRole('button', { name: 'Create Event' })).toBeNull();
  });

  it('asks whether interest in a repeating event is for this one or all of them', async () => {
    const setInterested = vi.fn();
    const only = { ...eventIn(2), interested: true, interested_all: false };
    const { rerender } = render(<Harness events={[only]} setInterested={setInterested} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Events' }));
    fireEvent.click(screen.getByRole('button', { name: /Interested/ }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Not interested in this event', 'Interested in all events']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Interested in all events' }));
    expect(setInterested).toHaveBeenCalledWith(7, { interested: true, interested_all: true });
    expect(setEventInterest).toHaveBeenCalledWith(7, true, { occurrence: false });

    // In all of them but this one: add this one back, or drop all.
    rerender(<Harness events={[{ ...only, interested: false, interested_all: true }]} setInterested={setInterested} />);
    fireEvent.click(screen.getByRole('button', { name: /Interested/ }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Interested in this event', 'Not interested in any of them']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Interested in this event' }));
    expect(setInterested).toHaveBeenLastCalledWith(7, { interested: true, interested_all: true });
    expect(setEventInterest).toHaveBeenLastCalledWith(7, true, { occurrence: true });
  });
});
