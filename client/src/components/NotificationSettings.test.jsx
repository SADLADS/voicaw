// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/pushService', () => ({
  getPushStatus: vi.fn(),
  enableNotifications: vi.fn(async () => 'granted'),
  disableNotificationsOnThisDevice: vi.fn(async () => {}),
  sendTestNotification: vi.fn(async () => 2),
}));
vi.mock('../services/settingsStore', () => ({
  getSetting: vi.fn(async () => true),
  setSetting: vi.fn(async () => {}),
}));

import NotificationSettings from './NotificationSettings';
import { ConfigContext } from '../App';
import {
  getPushStatus, enableNotifications, disableNotificationsOnThisDevice, sendTestNotification,
} from '../services/pushService';
import { setSetting } from '../services/settingsStore';

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

  it('saves the message preview setting', async () => {
    getPushStatus.mockReturnValue('granted');
    renderSettings();
    const checkbox = await screen.findByRole('checkbox', { name: /Show message text/ });
    await waitFor(() => expect(checkbox).toBeChecked());

    fireEvent.click(checkbox);

    expect(setSetting).toHaveBeenCalledWith('notificationPreviews', false);
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
});
