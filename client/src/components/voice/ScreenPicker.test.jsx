// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => ({
  platform: 'win32',
  getScreenSources: vi.fn(),
  chooseScreenSource: vi.fn(),
}));
vi.mock('../../utils/desktop', () => ({ desktop: bridge, isDesktopApp: () => true }));
const start = vi.hoisted(() => vi.fn());
vi.mock('../../voice/voiceClient', () => ({ startScreenShare: start }));

import ScreenPicker from './ScreenPicker';

const SOURCES = [
  { id: 'screen:0:0', name: 'Entire screen', kind: 'screen', thumbnail: 'data:image/png;base64,AA', icon: null },
  { id: 'window:12:0', name: 'Notes', kind: 'window', thumbnail: 'data:image/png;base64,BB', icon: 'data:image/png;base64,CC' },
];

describe('ScreenPicker', () => {
  beforeEach(() => {
    bridge.getScreenSources.mockResolvedValue({ canShareSound: true, sources: SOURCES });
    bridge.chooseScreenSource.mockResolvedValue(true);
    start.mockReset();
  });

  it('lists screens, then windows, and goes live with the one picked and its sound', async () => {
    const onClose = vi.fn();
    render(<ScreenPicker onClose={onClose} />);
    await screen.findByRole('option', { name: /Entire screen/ });
    expect(screen.queryByRole('option', { name: /Notes/ })).toBeNull();
    const goLive = screen.getByRole('button', { name: 'Go Live' });
    expect(goLive.disabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    fireEvent.click(screen.getByRole('option', { name: /Notes/ }));
    expect(screen.getByRole('checkbox', { name: /Share sound/ }).checked).toBe(true);
    fireEvent.click(goLive);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ audio: true }));
    expect(bridge.chooseScreenSource).toHaveBeenCalledWith('window:12:0', true);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no sound where the system can\'t share it, and picks again if the source went', async () => {
    bridge.getScreenSources.mockResolvedValue({ canShareSound: false, sources: SOURCES });
    bridge.chooseScreenSource.mockResolvedValue(false);
    const onClose = vi.fn();
    render(<ScreenPicker onClose={onClose} />);
    fireEvent.doubleClick(await screen.findByRole('option', { name: /Entire screen/ }));
    expect(screen.queryByRole('checkbox', { name: /Share sound/ })).toBeNull();
    await screen.findByText('That one has gone. Pick again.');
    expect(start).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
