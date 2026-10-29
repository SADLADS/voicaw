// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The desktop app's bridge (electron/preload.js), before anything reads it.
const bridge = vi.hoisted(() => {
  const api = {
    listener: null,
    onDownload: (cb) => { api.listener = cb; return () => { api.listener = null; }; },
    downloads: { open: vi.fn(), showInFolder: vi.fn(), remove: vi.fn() },
  };
  globalThis.window.voicawDesktop = api;
  return api;
});

import DownloadsPopup from './DownloadsPopup';
import { DOWNLOAD_POPUP_MS } from '../hooks/useDesktopDownloads';

const downloaded = (id, name) => act(() => bridge.listener({ id, name, folder: 'Downloads' }));

describe('DownloadsPopup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge.downloads.open.mockResolvedValue('');
    bridge.downloads.showInFolder.mockResolvedValue(undefined);
    bridge.downloads.remove.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows each finished file, newest first, and goes by itself', () => {
    render(<DownloadsPopup />);
    expect(screen.queryByText('Download complete')).toBeNull();
    downloaded(1, 'photo.png');
    downloaded(2, 'notes.txt');
    const names = [...document.querySelectorAll('.downloads-popup-name')].map((el) => el.textContent);
    expect(names).toEqual(['notes.txt', 'photo.png']);
    expect(screen.getAllByText('Saved in Downloads')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(DOWNLOAD_POPUP_MS));
    expect(screen.queryByText('Download complete')).toBeNull();
  });

  it('stays while the pointer is on it', () => {
    render(<DownloadsPopup />);
    downloaded(1, 'photo.png');
    fireEvent.pointerEnter(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(DOWNLOAD_POPUP_MS * 2));
    expect(screen.getByText('photo.png')).toBeTruthy();
    fireEvent.pointerLeave(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(DOWNLOAD_POPUP_MS));
    expect(screen.queryByText('photo.png')).toBeNull();
  });

  it('opens, shows and deletes the file by its id', async () => {
    render(<DownloadsPopup />);
    downloaded(7, 'photo.png');
    fireEvent.click(screen.getByText('Show in folder'));
    expect(bridge.downloads.showInFolder).toHaveBeenCalledWith(7);
    await act(async () => fireEvent.click(screen.getByText('Open file')));
    expect(bridge.downloads.open).toHaveBeenCalledWith(7);
    expect(screen.queryByText('photo.png')).toBeNull();

    downloaded(8, 'old.zip');
    await act(async () => fireEvent.click(screen.getByText('Delete')));
    expect(bridge.downloads.remove).toHaveBeenCalledWith(8);
    expect(screen.queryByText('old.zip')).toBeNull();
  });

  it("says when the file can't be opened or is gone", async () => {
    render(<DownloadsPopup />);
    downloaded(1, 'a.xyz');
    bridge.downloads.open.mockResolvedValueOnce('No application');
    await act(async () => fireEvent.click(screen.getByText('Open file')));
    expect(screen.getByText("Couldn't open the file")).toBeTruthy();
    bridge.downloads.open.mockResolvedValueOnce('missing');
    await act(async () => fireEvent.click(screen.getByText('Open file')));
    expect(screen.getByText("The file isn't there any more")).toBeTruthy();
  });

  it('closes with ×', () => {
    render(<DownloadsPopup />);
    downloaded(1, 'photo.png');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('photo.png')).toBeNull();
  });
});
