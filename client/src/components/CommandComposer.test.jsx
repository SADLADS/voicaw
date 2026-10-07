// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/interactionService', () => ({
  fetchCommands: vi.fn(),
  runCommand: vi.fn(),
  autocomplete: vi.fn(),
  handleInteractionResult: vi.fn((r) => r),
}));
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../services/typingService', () => ({ noteTyping: vi.fn(), typingDone: vi.fn() }));

import Composer from './Composer';
import { editorFor } from '../editor/editorRegistry';
import { fetchCommands, runCommand, autocomplete, handleInteractionResult } from '../services/interactionService';
import { clearCommandCache } from '../hooks/useChannelCommands';

const bot = { id: 9, name: 'Weather Bot', avatar: null };
const COMMANDS = [
  {
    id: 1, application_id: 9, type: 1, name: 'weather', description: 'The forecast', bot,
    options: [
      { type: 3, name: 'city', description: 'Where', required: true, autocomplete: true },
      { type: 4, name: 'days', description: 'How many', min_value: 1, max_value: 7 },
      { type: 5, name: 'metric', description: 'Celsius?' },
    ],
  },
  {
    id: 2, application_id: 9, type: 1, name: 'admin', description: 'Admin things', bot,
    options: [{ type: 1, name: 'kick', description: 'Kick someone', options: [{ type: 6, name: 'who', description: 'Who', required: true }] }],
  },
  { id: 3, application_id: 9, type: 3, name: 'Quote', description: '', bot, options: [] },
];

const people = [{ id: 5, username: 'alice' }, { id: 6, username: 'bob' }];

function Harness({ channelId = 42 }) {
  const inputRef = useRef(null);
  return (
    <Composer
      chatId={`channel-${channelId}`}
      chatName="#general"
      isMobile={false}
      maxPlaintextLength={2000}
      inputRef={inputRef}
      onCancelReply={() => {}}
      setError={() => {}}
      showEmojiPicker={false}
      setShowEmojiPicker={() => {}}
      onSend={vi.fn()}
      people={people}
      roleInfo={{ 7: { name: 'Mods', color: null } }}
      channels={[{ id: 42, name: 'general', type: 'text' }]}
      commandChannelId={channelId}
    />
  );
}

const box = () => document.getElementById('dm-input');
const type = (text) => act(() => { editorFor(box()).setText(text); });
const options = () => screen.getAllByRole('option').map((o) => o.textContent);

beforeEach(() => {
  clearCommandCache();
  vi.clearAllMocks();
  fetchCommands.mockResolvedValue(COMMANDS);
});
afterEach(() => vi.useRealTimers());

describe('the "/" command picker', () => {
  it('lists slash commands (subcommands as their own entries) and filters them', async () => {
    render(<Harness />);
    type('/');
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options()[0]).toContain('/weather');
    // Under their bot's section.
    expect(screen.getByRole('group', { name: 'Weather Bot' }).textContent).toContain('/weather');
    expect(options()[1]).toContain('/admin kick');
    // Message commands aren't in the list.
    expect(screen.queryByText('/Quote')).toBeNull();
    type('/adm');
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]).toContain('/admin kick');
    // Asked again when the list opened.
    expect(fetchCommands).toHaveBeenCalledWith(42);
  });

  it('runs a command with its options in Discord\'s shape once the required ones are filled', async () => {
    runCommand.mockResolvedValue({ ok: true });
    render(<Harness />);
    type('/we');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole('option'));
    const form = screen.getByRole('form', { name: 'Use /weather' });
    expect(form).toBeInTheDocument();
    expect(editorFor(box()).getText()).toBe('');

    // Required city missing.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Fill in: city')).toBeInTheDocument();
    expect(runCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/city/), { target: { value: 'London' } });
    fireEvent.change(screen.getByLabelText(/days/), { target: { value: '9' } });
    expect(screen.getByText('At most 7')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/days/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/metric/), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith(42, {
      commandId: 1,
      options: [{ name: 'city', type: 3, value: 'London' }, { name: 'days', type: 4, value: 3 }, { name: 'metric', type: 5, value: true }],
      files: {},
    }));
    expect(handleInteractionResult).toHaveBeenCalledWith({ ok: true });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Use /weather' })).toBeNull());
  });

  it('nests a subcommand\'s options and offers the guild\'s members', async () => {
    runCommand.mockResolvedValue({ ok: true });
    render(<Harness />);
    type('/admin');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole('option'));
    fireEvent.change(screen.getByLabelText(/who/), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith(42, {
      commandId: 2,
      options: [{ name: 'kick', type: 1, options: [{ name: 'who', type: 6, value: '6' }] }],
      files: {},
    }));
  });

  it('keeps the fields and says so when the bot doesn\'t answer; Escape leaves', async () => {
    runCommand.mockRejectedValue({ response: { status: 504, data: { error: 'The application did not respond' } } });
    render(<Harness />);
    type('/we');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole('option'));
    fireEvent.change(screen.getByLabelText(/city/), { target: { value: 'Paris' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('The application did not respond')).toBeInTheDocument();
    expect(screen.getByLabelText(/city/)).toHaveValue('Paris');
    fireEvent.keyDown(screen.getByLabelText(/city/), { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Use /weather' })).toBeNull();
  });

  it('asks the bot for suggestions once typing pauses, and uses the one picked', async () => {
    autocomplete.mockResolvedValue([{ name: 'London', value: 'london' }, { name: 'Lisbon', value: 'lisbon' }]);
    runCommand.mockResolvedValue({ ok: true });
    render(<Harness />);
    type('/we');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.mouseDown(screen.getByRole('option'));
    vi.useFakeTimers();
    const city = screen.getByLabelText(/city/);
    fireEvent.focus(city);
    fireEvent.change(city, { target: { value: 'L' } });
    fireEvent.change(city, { target: { value: 'Li' } });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(autocomplete).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(autocomplete).toHaveBeenCalledTimes(1);
    expect(autocomplete).toHaveBeenCalledWith(42, 1, [{ name: 'city', type: 3, value: 'Li', focused: true }]);
    vi.useRealTimers();
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Lisbon' }));
    expect(city).toHaveValue('Lisbon');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith(42, { commandId: 1, options: [{ name: 'city', type: 3, value: 'lisbon' }], files: {} }));
  });

  it('never appears outside guild channels', async () => {
    const inputRef = { current: null };
    render(
      <Composer chatId="5" chatName="Alice" isMobile={false} maxPlaintextLength={2000} inputRef={inputRef}
        onCancelReply={() => {}} setError={() => {}} showEmojiPicker={false} setShowEmojiPicker={() => {}} onSend={vi.fn()} />
    );
    type('/');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('listbox', { name: 'Bot commands' })).toBeNull();
    expect(fetchCommands).not.toHaveBeenCalled();
  });
});
