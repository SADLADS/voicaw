// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/pushService', () => ({
  getPushStatus: vi.fn(),
  enableNotifications: vi.fn(async () => 'granted'),
}));

import NotificationPrompt from './NotificationPrompt';
import { ConfigContext } from '../App';
import { getPushStatus, enableNotifications } from '../services/pushService';

const renderPrompt = () =>
  render(
    <ConfigContext.Provider value={{ vapidPublicKey: 'VAPID-KEY' }}>
      <NotificationPrompt />
    </ConfigContext.Provider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('NotificationPrompt', () => {
  it('offers to enable notifications and does it on tap', async () => {
    getPushStatus.mockReturnValueOnce('can-enable').mockReturnValue('granted');
    renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(enableNotifications).toHaveBeenCalledWith('VAPID-KEY');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument());
  });

  it('explains the Home Screen requirement on iPhone/iPad in the browser', () => {
    getPushStatus.mockReturnValue('needs-install');
    renderPrompt();

    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it('stays dismissed', () => {
    getPushStatus.mockReturnValue('can-enable');
    const { unmount } = renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Get notified/)).not.toBeInTheDocument();
    unmount();

    renderPrompt();
    expect(screen.queryByText(/Get notified/)).not.toBeInTheDocument();
  });

  it('shows nothing when notifications are on, off, blocked or unsupported', () => {
    for (const status of ['granted', 'off', 'denied', 'unsupported']) {
      getPushStatus.mockReturnValue(status);
      const { container, unmount } = renderPrompt();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
