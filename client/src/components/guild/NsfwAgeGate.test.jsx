// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({ default: { put: vi.fn() } }));

import api from '../../utils/api';
import NsfwAgeGate from './NsfwAgeGate';
import { getPreferences, resetPreferences } from '../../utils/preferences';

beforeEach(() => {
  resetPreferences();
  vi.clearAllMocks();
});

describe('NSFW age gate', () => {
  it('opens only once "I am 18 or over" is ticked, saving just that answer', async () => {
    api.put.mockResolvedValue({ data: { blurNsfw: true, adultConfirmed: true } });
    render(<NsfwAgeGate channelName="after-dark" onBack={() => {}} />);
    expect(screen.getByRole('heading')).toHaveTextContent('#after-dark is an NSFW channel');
    const go = screen.getByRole('button', { name: 'Continue' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I am 18 or over'));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(getPreferences().adultConfirmed).toBe(true));
    expect(api.put).toHaveBeenCalledWith('/preferences', { adultConfirmed: true });
  });

  it('says so when it could not be saved, and stays closed', async () => {
    api.put.mockRejectedValue(new Error('offline'));
    render(<NsfwAgeGate channelName="after-dark" onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText('I am 18 or over'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that");
    expect(getPreferences().adultConfirmed).toBe(false);
  });

  it('goes back without asking anything', () => {
    const onBack = vi.fn();
    render(<NsfwAgeGate channelName="after-dark" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(onBack).toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
});
