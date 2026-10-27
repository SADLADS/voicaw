// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const desktopApp = vi.hoisted(() => ({
  onNavigate: vi.fn((listener) => { desktopApp.navigateTo = listener; return () => {}; }),
  onShortcut: vi.fn(() => () => {}),
  onActivities: vi.fn(() => () => {}),
  getActivities: vi.fn(async () => [{ name: 'FTL', type: 0 }]),
  setUnread: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../utils/desktop', () => ({ desktop: desktopApp, unreadSummary: () => ({ count: 0, dot: false }) }));
vi.mock('../utils/ws-client', () => ({ onNotification: vi.fn(() => () => {}), setOwnActivities: vi.fn() }));
vi.mock('../services/pushNotifications', () => ({ notificationFromPush: vi.fn() }));
vi.mock('../voice/voiceClient', () => ({ getVoiceSnapshot: vi.fn(), leaveVoice: vi.fn(), setSelfDeaf: vi.fn(), setSelfMute: vi.fn() }));
vi.mock('../voice/callClient', () => ({ hangUp: vi.fn() }));

const { setOwnActivities } = await import('../utils/ws-client');
const { useDesktopApp } = await import('./useDesktopApp');

describe('useDesktopApp', () => {
  it('keeps sharing activities across navigations (set up once), and opens links with the latest navigate', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook((props) => useDesktopApp(props), { initialProps: { navigate: first } });
    await vi.waitFor(() => expect(setOwnActivities).toHaveBeenCalledWith([{ name: 'FTL', type: 0 }]));
    // A new page gives a new navigate: nothing is cleared or asked for again.
    rerender({ navigate: second });
    rerender({ navigate: vi.fn() });
    rerender({ navigate: second });
    expect(setOwnActivities).not.toHaveBeenCalledWith([]);
    expect(desktopApp.getActivities).toHaveBeenCalledTimes(1);
    expect(desktopApp.onActivities).toHaveBeenCalledTimes(1);
    desktopApp.navigateTo('/dm/5');
    expect(second).toHaveBeenCalledWith('/dm/5');
    expect(first).not.toHaveBeenCalled();
    // Logged out: none.
    unmount();
    expect(setOwnActivities).toHaveBeenLastCalledWith([]);
  });
});
