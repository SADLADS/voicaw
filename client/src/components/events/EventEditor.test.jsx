// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../services/guildService', () => ({
  createEvent: vi.fn(async (guildId, fields) => ({ id: 80, guild_id: guildId, ...fields, status: 'scheduled', user_count: 1, interested: true })),
  updateEvent: vi.fn(async (id, fields) => ({ id, ...fields })),
  moveOccurrence: vi.fn(async (id, times) => ({ id, ...times })),
}));
vi.mock('../../services/attachmentUpload', () => ({ uploadAttachment: vi.fn() }));

import EventEditor from './EventEditor';
import { createEvent, moveOccurrence } from '../../services/guildService';
import { ConfigContext } from '../../contexts';

const CREATE_EVENTS = 1 << 27;
const CONNECT = 1 << 12;
const guild = {
  id: 5,
  my_permissions: 1 | CREATE_EVENTS,
  channels: [
    { id: 10, name: 'general', type: 'text', my_permissions: 1 },
    { id: 12, name: 'lounge', type: 'voice', my_permissions: 1 | CONNECT | CREATE_EVENTS },
    { id: 13, name: 'stage', type: 'voice', my_permissions: 1 },
  ],
};

const renderEditor = (props) => render(
  <ConfigContext.Provider value={{ s3Endpoint: '' }}>
    <EventEditor guild={guild} onSaved={vi.fn()} onClose={vi.fn()} {...props} />
  </ConfigContext.Provider>
);

// Tomorrow's date as the date input wants it.
function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => vi.clearAllMocks());

describe('EventEditor', () => {
  it('makes an event in a voice channel, in three steps', async () => {
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    // Only the voice channels you may hold an event in.
    const select = screen.getByLabelText('Channel');
    expect([...select.options].map((o) => o.textContent)).toEqual(['lounge']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // A name is needed.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the event a topic.');
    fireEvent.change(screen.getByLabelText('Event topic'), { target: { value: 'Game night' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: tomorrow() } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '20:00' } });
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Bring snacks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('article', { name: 'Game night' })).toHaveTextContent('lounge');
    fireEvent.click(screen.getByRole('button', { name: 'Create Event' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [guildId, fields] = createEvent.mock.calls[0];
    expect(guildId).toBe(5);
    expect(fields).toMatchObject({
      name: 'Game night', description: 'Bring snacks', entityType: 'voice', channelId: 12, location: null, endTime: null,
      recurrence: { frequency: 2, interval: 1 }, timezone: expect.any(String),
    });
    expect(new Date(fields.startTime * 1000).getHours()).toBe(20);
  });

  it('needs an end somewhere else, not a location', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText(/Somewhere else/));
    expect(screen.getByLabelText('Location (optional)')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Event topic'), { target: { value: 'Picnic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Events somewhere else need an end date and time.');
  });

  it('makes an all-day event today, in a colour', async () => {
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    fireEvent.click(screen.getByLabelText(/Somewhere else/));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Event topic'), { target: { value: 'Open day' } });
    fireEvent.click(screen.getByLabelText('All day'));
    expect(screen.queryByLabelText('Start time')).toBeNull();
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: today } });
    expect(screen.getByLabelText('End date')).toHaveValue(today);
    fireEvent.click(screen.getByRole('radio', { name: '#3498db' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('article', { name: 'Open day' })).toHaveTextContent('All day');
    fireEvent.click(screen.getByRole('button', { name: 'Create Event' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, fields] = createEvent.mock.calls[0];
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    expect(fields).toMatchObject({
      allDay: true, color: 0x3498db, emoji: null, timezone: expect.any(String),
      startTime: midnight.getTime() / 1000,
      endTime: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000,
    });
  });

  it("won't take an all-day event whose last day is before its first", () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Event topic'), { target: { value: 'Trip' } });
    fireEvent.click(screen.getByLabelText('All day'));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: tomorrow() } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2020-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent("The last day can't be before the first.");
  });

  it('goes to a step clicked at the top, not past one with something missing', () => {
    renderEditor();
    const steps = within(screen.getByRole('list', { name: 'Steps' }));
    // Nothing named yet: Review stops at Event info, and says why.
    fireEvent.click(steps.getByRole('button', { name: 'Review' }));
    expect(screen.getByLabelText('Event topic')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Give the event a topic.');
    fireEvent.change(screen.getByLabelText('Event topic'), { target: { value: 'Game night' } });
    fireEvent.click(steps.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Game night')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // Back to any earlier step, and forward again with what was filled in.
    fireEvent.click(steps.getByRole('button', { name: 'Location' }));
    expect(screen.getByLabelText('Channel')).toBeInTheDocument();
    fireEvent.click(steps.getByRole('button', { name: 'Event info' }));
    expect(screen.getByLabelText('Event topic')).toHaveValue('Game night');
  });

  it('moves just one occurrence', async () => {
    const onSaved = vi.fn();
    const start = Math.floor(Date.now() / 1000) + 86400;
    const event = { id: 9, name: 'Weekly', entity_type: 'external', location: 'x', start_time: start, end_time: start + 3600, recurrence: { frequency: 2, interval: 1, by_weekday: [0] } };
    renderEditor({ event, occurrence: true, onSaved });
    expect(screen.getByRole('dialog', { name: "Change this event's time" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(new Date(moveOccurrence.mock.calls[0][1].startTime * 1000).getHours()).toBe(8);
  });
});
