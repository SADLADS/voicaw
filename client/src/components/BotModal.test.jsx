// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/interactionService', async () => {
  const actual = await vi.importActual('../services/interactionService');
  return { ...actual, submitModal: vi.fn(async () => ({ ok: true })) };
});
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

import BotModal from './BotModal';
import { showBotModal, submitModal } from '../services/interactionService';

const modal = {
  id: 'm1',
  custom_id: 'fb',
  title: 'Feedback',
  bot: { id: 7, name: 'Helper' },
  components: [
    { type: 1, components: [{ type: 4, custom_id: 'name', label: 'Your name', style: 1, value: 'Ann', required: true }] },
    { type: 1, components: [{ type: 4, custom_id: 'text', label: 'Thoughts', style: 2, min_length: 5, placeholder: 'Tell us', required: true }] },
    { type: 18, label: 'Mood', description: 'How do you feel?', component: { type: 3, custom_id: 'mood', min_values: 1, max_values: 1, required: true,
      options: [{ label: 'Happy', value: 'happy' }, { label: 'Sad', value: 'sad', default: true }] } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  act(() => showBotModal(null));
});

describe('BotModal', () => {
  it('shows a bot\'s form with its fields, prefilled values and defaults', () => {
    render(<BotModal />);
    act(() => showBotModal(modal));
    expect(screen.getByRole('dialog', { name: 'Feedback' })).toBeInTheDocument();
    expect(screen.getByText('From Helper')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your name/)).toHaveValue('Ann');
    const thoughts = screen.getByLabelText(/Thoughts/);
    expect(thoughts.tagName).toBe('TEXTAREA');
    expect(thoughts).toHaveAttribute('placeholder', 'Tell us');
    expect(screen.getByText('How do you feel?')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Sad/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('checks the answers as the bot asked before sending them, then closes', async () => {
    render(<BotModal />);
    act(() => showBotModal(modal));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Thoughts is required');
    fireEvent.change(screen.getByLabelText(/Thoughts/), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Thoughts needs at least 5 characters');
    expect(submitModal).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Thoughts/), { target: { value: 'Lovely app' } });
    fireEvent.click(screen.getByRole('option', { name: /Happy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitModal).toHaveBeenCalledWith('m1', { name: 'Ann', text: 'Lovely app', mood: ['happy'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the form open with the error when sending fails, and Cancel closes it', async () => {
    submitModal.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 504 } }));
    render(<BotModal />);
    act(() => showBotModal({ ...modal, components: [modal.components[0]] }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('The application did not respond')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
