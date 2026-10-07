// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => ({ app: true, access: 'none' }));

vi.mock('../utils/android', () => ({
  android: { openSettings: vi.fn(async () => {}) },
  isAndroidApp: () => bridge.app,
  mediaAccess: vi.fn(async () => bridge.access),
  requestMediaAccess: vi.fn(async () => bridge.access),
  listMedia: vi.fn(async (offset) => (offset > 0 ? [] : [
    { id: 'i1', uri: 'content://media/external/images/media/1', type: 'image/jpeg', name: 'cat.jpg', size: 3 },
    { id: 'v2', uri: 'content://media/external/video/media/2', type: 'video/mp4', name: 'clip.mp4', size: 5, duration: 75000 },
  ])),
  mediaThumbnail: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  readMedia: vi.fn(async (item) => new File(['abc'], item.name, { type: item.type })),
}));

import AttachPanel from './AttachPanel';
import { android, readMedia, requestMediaAccess } from '../utils/android';

function renderPanel(props = {}) {
  const handlers = {
    onAddFiles: vi.fn(),
    onRemove: vi.fn(),
    onPickFiles: vi.fn(),
    onPoll: vi.fn(),
    onThread: null,
    onError: vi.fn(),
    ...props,
  };
  const view = render(<AttachPanel height={300} picked={[]} {...handlers} />);
  return { ...handlers, rerender: (more) => view.rerender(<AttachPanel height={300} picked={[]} {...handlers} {...more} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.app = true;
  bridge.access = 'none';
});

describe('AttachPanel', () => {
  it('asks for the photos, then lists them; refused, it points at Android settings', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow access' }));
    await waitFor(() => expect(requestMediaAccess).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    expect(android.openSettings).toHaveBeenCalledWith({ which: 'app' });

    bridge.access = 'all';
    renderPanel();
    expect(await screen.findByRole('button', { name: 'cat.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'clip.mp4' })).toHaveTextContent('1:15');
  });

  it('attaches a photo when tapped and takes it back when tapped again', async () => {
    bridge.access = 'all';
    const { onAddFiles, onRemove, rerender } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'cat.jpg' }));
    await waitFor(() => expect(onAddFiles).toHaveBeenCalled());
    expect(readMedia).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }));
    const [[files, options]] = onAddFiles.mock.calls;
    expect(files[0].name).toBe('cat.jpg');
    expect(options).toEqual({ source: 'i1' });

    rerender({ picked: ['v2', 'i1'] });
    const tile = screen.getByRole('button', { name: 'cat.jpg' });
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(tile).toHaveTextContent('2');
    fireEvent.click(tile);
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('i1'));
  });

  it('offers choosing more when only some photos are allowed', async () => {
    bridge.access = 'some';
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Choose more' }));
    expect(requestMediaAccess).toHaveBeenCalled();
  });

  it('on the web: camera and the photo picker instead of a grid, and the bar', async () => {
    bridge.app = false;
    const onThread = vi.fn();
    const { onPickFiles, onPoll } = renderPanel({ onThread });
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    expect(onPickFiles).toHaveBeenLastCalledWith({ accept: 'image/*', capture: 'environment' });
    const photos = screen.getAllByRole('button', { name: 'Photos' });
    expect(photos).toHaveLength(2); // the tile and the bar's
    fireEvent.click(photos[1]);
    expect(onPickFiles).toHaveBeenLastCalledWith({ accept: 'image/*,video/*' });
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onPickFiles).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole('button', { name: 'Poll' }));
    expect(onPoll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
    expect(onThread).toHaveBeenCalled();
  });

  it('has no Thread button where threads can’t be started', () => {
    bridge.app = false;
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Thread' })).toBeNull();
  });
});
