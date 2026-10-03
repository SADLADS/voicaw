// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/interactionService', () => ({
  useComponent: vi.fn(async () => ({ ok: true })),
  handleInteractionResult: vi.fn((r) => r),
  dismissEphemeral: vi.fn(async () => {}),
}));

import MessageComponents from './MessageComponents';
import { useComponent, handleInteractionResult } from '../services/interactionService';
import { ChannelMentionContext } from '../contexts';

const buttons = {
  type: 1,
  components: [
    { type: 2, style: 1, label: 'Yes', custom_id: 'yes' },
    { type: 2, style: 4, label: 'No', custom_id: 'no', disabled: true },
    { type: 2, style: 5, label: 'Docs', url: 'https://example.com/docs' },
  ],
};
const fruit = {
  type: 1,
  components: [{ type: 3, custom_id: 'fruit', placeholder: 'Pick fruit', min_values: 1, max_values: 1, options: [
    { label: 'Apple', value: 'apple', description: 'Crunchy' }, { label: 'Pear', value: 'pear' },
  ] }],
};

function draw(components, extra = {}) {
  return render(<MessageComponents messageId={42} channelId={5} components={components} names={{ 2: 'bob', 3: 'carol' }} roles={{ 9: { name: 'Mods', color: '#f00' } }} {...extra} />);
}

beforeEach(() => vi.clearAllMocks());

describe('MessageComponents', () => {
  it('draws buttons in their styles; a click asks the bot', async () => {
    draw([buttons]);
    const yes = screen.getByRole('button', { name: 'Yes' });
    expect(yes).toHaveClass('bot-button', 'primary');
    expect(screen.getByRole('button', { name: 'No' })).toBeDisabled();
    fireEvent.click(yes);
    await waitFor(() => expect(useComponent).toHaveBeenCalledWith(42, 'yes', undefined));
    expect(handleInteractionResult).toHaveBeenCalledWith({ ok: true });
  });

  it('opens a link button in a new tab without telling the site where from, and never asks the bot', () => {
    draw([buttons]);
    const link = screen.getByRole('link', { name: /Docs/ });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(link);
    expect(useComponent).not.toHaveBeenCalled();
  });

  it('says the interaction failed, or that the bot did not respond, for a few seconds', async () => {
    vi.useFakeTimers();
    useComponent.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 504 } }));
    draw([buttons]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('The application did not respond');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByRole('alert')).toBeNull();
    useComponent.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 400 } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('This interaction failed');
    vi.useRealTimers();
  });

  it('sends a string select choice straight away', async () => {
    draw([fruit]);
    fireEvent.click(screen.getByRole('button', { name: /Pick fruit/ }));
    expect(screen.getByText('Crunchy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Pear/ }));
    await waitFor(() => expect(useComponent).toHaveBeenCalledWith(42, 'fruit', ['pear']));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('lets several be ticked, within the limits, then sends them with Done', async () => {
    const many = { type: 1, components: [{ ...fruit.components[0], min_values: 2, max_values: 2 }] };
    draw([many]);
    fireEvent.click(screen.getByRole('button', { name: /Pick fruit/ }));
    fireEvent.click(screen.getByRole('option', { name: /Apple/ }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: /Pear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(useComponent).toHaveBeenCalledWith(42, 'fruit', ['apple', 'pear']));
  });

  it('lists the guild for user, role and channel selects', async () => {
    const selects = [
      { type: 1, components: [{ type: 5, custom_id: 'who', placeholder: 'Someone' }] },
      { type: 1, components: [{ type: 7, custom_id: 'any', placeholder: 'Anything' }] },
      { type: 1, components: [{ type: 8, custom_id: 'where', placeholder: 'Somewhere', channel_types: [0] }] },
    ];
    const directory = { channels: {
      5: { id: 5, guildId: 1, name: 'general', type: 'text' },
      6: { id: 6, guildId: 1, name: 'Lounge', type: 'voice' },
      7: { id: 7, guildId: 2, name: 'elsewhere', type: 'text' },
    } };
    render(
      <ChannelMentionContext.Provider value={directory}>
        <MessageComponents messageId={42} channelId={5} components={selects} names={{ 2: 'bob' }} roles={{ 9: { name: 'Mods' } }} />
      </ChannelMentionContext.Provider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Anything/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['bob', 'Mods']);
    // Pressing elsewhere closes the open list (a real click starts with mousedown).
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole('button', { name: /Somewhere/ }));
    // Only this guild's text channels.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['general']);
    fireEvent.click(screen.getByRole('option', { name: 'general' }));
    await waitFor(() => expect(useComponent).toHaveBeenCalledWith(42, 'where', ['5']));
  });
});
