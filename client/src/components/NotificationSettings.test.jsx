// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/pushService', () => ({
  getPushStatus: vi.fn(),
  enableNotifications: vi.fn(async () => 'granted'),
  disableNotificationsOnThisDevice: vi.fn(async () => {}),
  sendTestNotification: vi.fn(async () => ({ devices: 2, delivered: 2 })),
  ensureSubscription: vi.fn(async () => {}),
}));

import NotificationSettings from './NotificationSettings';
import { ConfigContext } from '../contexts';
import {
  getPushStatus, enableNotifications, disableNotificationsOnThisDevice, sendTestNotification,
  ensureSubscription,
} from '../services/pushService';

const renderSettings = () =>
  render(
    <ConfigContext.Provider value={{ vapidPublicKey: 'VAPID-KEY' }}>
      <NotificationSettings />
    </ConfigContext.Provider>
  );

beforeEach(() => vi.clearAllMocks());

describe('NotificationSettings', () => {
  it('turns notifications on', async () => {
    getPushStatus.mockReturnValueOnce('can-enable').mockReturnValue('granted');
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(enableNotifications).toHaveBeenCalledWith('VAPID-KEY');
    expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
  });

  it('turns them off for this device and remembers it', async () => {
    getPushStatus.mockReturnValueOnce('granted').mockReturnValue('off');
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(disableNotificationsOnThisDevice).toHaveBeenCalledWith({ remember: true }));
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });

  it('sends a test notification and says how many devices got it', async () => {
    getPushStatus.mockReturnValue('granted');
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(sendTestNotification).toHaveBeenCalled();
    expect(await screen.findByText('Sent to 2 devices.')).toBeInTheDocument();
  });

  it('explains blocked notifications and the iOS Home Screen requirement', () => {
    getPushStatus.mockReturnValue('denied');
    const { unmount } = renderSettings();
    expect(screen.getByText(/blocked for Voicaw in this browser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
    unmount();

    getPushStatus.mockReturnValue('needs-install');
    renderSettings();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });

  it('makes sure this device is registered when notifications look on', async () => {
    getPushStatus.mockReturnValue('granted');
    renderSettings();

    await waitFor(() => expect(ensureSubscription).toHaveBeenCalledWith('VAPID-KEY'));
    expect(screen.getByText('Notifications are on for this device.')).toBeInTheDocument();
  });

  it('shows why this device could not be registered and offers to try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getPushStatus.mockReturnValue('granted');
    ensureSubscription.mockRejectedValueOnce(new Error('Service worker is not available'));
    renderSettings();

    expect(await screen.findByText(/couldn't be registered: Service worker is not available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(enableNotifications).toHaveBeenCalledWith('VAPID-KEY');
    await waitFor(() => expect(screen.getByText('Notifications are on for this device.')).toBeInTheDocument());
  });

  it('distinguishes no devices from devices that could not be reached', async () => {
    getPushStatus.mockReturnValue('granted');
    sendTestNotification.mockResolvedValueOnce({ devices: 0, delivered: 0 });
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));
    expect(await screen.findByText(/No devices are set up/)).toBeInTheDocument();

    sendTestNotification.mockResolvedValueOnce({ devices: 3, delivered: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }));
    expect(await screen.findByText("Sent to 1 of 3 devices; the rest couldn't be reached.")).toBeInTheDocument();
  });
});
