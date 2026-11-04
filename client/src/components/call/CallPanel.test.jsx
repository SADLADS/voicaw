// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({ voice: {}, call: null, groupCall: null }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));
vi.mock('../../hooks/useCall', () => ({ useCall: () => state.call, useGroupCall: () => state.groupCall }));
vi.mock('../../hooks/useStreamWindow', () => ({ useStreamWindow: () => null }));
vi.mock('../../voice/callClient', () => ({ hangUp() {}, joinGroupCallById() {} }));
vi.mock('../../voice/voiceClient', async (importOriginal) => ({
  ...(await importOriginal()),
  watchStream: vi.fn(),
  focusCamera: vi.fn(),
  showCamera: () => () => {},
  attachStream: () => () => {},
  canShareScreen: () => true,
}));

import CallPanel from './CallPanel';
import GroupCallPanel from '../group/GroupCallPanel';
import { focusCamera, watchStream } from '../../voice/voiceClient';

const alice = { id: 1, username: 'alice' };
const bob = { id: 2, username: 'bob' };

function inCall(changes = {}) {
  state.voice = {
    status: 'connected', callId: 'c1', channelId: null, identity: '1', canStream: true, canCamera: true,
    speaking: [], muted: [], cameras: [], streams: [], watching: null, watchingReady: false,
    streaming: false, selfMute: false, selfDeaf: false, ...changes,
  };
}

beforeEach(() => {
  state.call = { id: 'c1', peerId: 2, state: 'active', outgoing: true, answeredAt: Date.now() };
  inCall();
});

afterEach(() => {
  cleanup();
  vi.mocked(watchStream).mockClear();
  vi.mocked(focusCamera).mockClear();
});

describe('Focusing a camera in a call', () => {
  const tileOf = (label) => screen.getByLabelText(label).closest('.call-panel-person');

  it('focuses on a click, opens the volume on a right click or Enter never', () => {
    inCall({ cameras: ['2'], focusedCamera: null });
    render(<CallPanel user={alice} peer={bob} />);
    const tile = tileOf("bob's camera");
    fireEvent.click(tile, { detail: 1 });
    expect(focusCamera).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    vi.mocked(focusCamera).mockClear();
    fireEvent.keyDown(tile, { key: 'Enter' });
    expect(focusCamera).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.contextMenu(tile);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('ignores the second click of a double click', () => {
    inCall({ cameras: ['2'], focusedCamera: null });
    render(<CallPanel user={alice} peer={bob} />);
    fireEvent.click(tileOf("bob's camera"), { detail: 2 });
    expect(focusCamera).not.toHaveBeenCalled();
  });

  it('opens the volume on a long press', () => {
    vi.useFakeTimers();
    try {
      inCall({ cameras: ['2'], focusedCamera: null });
      render(<CallPanel user={alice} peer={bob} />);
      const tile = tileOf("bob's camera");
      fireEvent.touchStart(tile, { touches: [{ clientX: 5, clientY: 5 }] });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.touchEnd(tile);
      fireEvent.click(tile, { detail: 1 });
      expect(focusCamera).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets you focus your own, without a volume', () => {
    inCall({ cameras: ['1'], focusedCamera: null });
    render(<CallPanel user={alice} peer={bob} />);
    const tile = tileOf('Your camera');
    fireEvent.click(tile, { detail: 1 });
    expect(focusCamera).toHaveBeenCalledWith(1);
    fireEvent.contextMenu(tile);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the focused camera big once, with the person’s picture in their place; a click there goes back', () => {
    inCall({ cameras: ['2'], focusedCamera: '2' });
    const { container } = render(<CallPanel user={alice} peer={bob} />);
    expect(container.querySelector('.stream-view.camera')).not.toBeNull();
    expect(screen.getAllByLabelText("bob's camera")).toHaveLength(1);
    const person = [...container.querySelectorAll('.call-panel-person')].find((el) => el.title === 'Back to everyone');
    fireEvent.click(person, { detail: 1 });
    expect(focusCamera).toHaveBeenCalledWith(null);
  });

  it('keeps a watched stream playing small under a focused camera, one click from coming back', () => {
    inCall({ cameras: ['2'], focusedCamera: '2', streams: ['2'], watching: '2' });
    const { container } = render(<CallPanel user={alice} peer={bob} />);
    const tile = container.querySelector('.stream-tile');
    expect(tile.textContent).toContain("bob's screen");
    fireEvent.click(tile, { detail: 1 });
    expect(focusCamera).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(watchStream).toHaveBeenCalledWith(null);
  });

  it('doesn’t push a focused camera aside when the other person starts sharing', () => {
    inCall({ cameras: ['2'], focusedCamera: '2', streams: ['2'] });
    render(<CallPanel user={alice} peer={bob} />);
    expect(watchStream).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Watch Stream' })).toBeTruthy();
  });

  it('Escape goes back to everyone, arrows step through the cameras; not over the volume menu', () => {
    inCall({ cameras: ['1', '2'], focusedCamera: '2' });
    const { container } = render(<CallPanel user={alice} peer={bob} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(focusCamera).toHaveBeenLastCalledWith('1');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(focusCamera).toHaveBeenLastCalledWith(null);
    vi.mocked(focusCamera).mockClear();
    fireEvent.contextMenu([...container.querySelectorAll('.call-panel-person')].find((el) => el.title === 'Back to everyone'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(focusCamera).not.toHaveBeenCalled();
  });
});

describe('Screen sharing in a 1:1 call', () => {
  it('offers sharing your screen', () => {
    render(<CallPanel user={alice} peer={bob} />);
    expect(screen.getByRole('button', { name: 'Share your screen' })).toBeTruthy();
  });

  it('opens the other person’s stream on its own, marked Live', () => {
    inCall({ streams: ['2'] });
    render(<CallPanel user={alice} peer={bob} />);
    expect(watchStream).toHaveBeenCalledWith(2);
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
  });

  it('doesn’t take over a stream already being watched (your own preview)', () => {
    inCall({ streams: ['1', '2'], watching: '1', streaming: true });
    render(<CallPanel user={alice} peer={bob} />);
    expect(watchStream).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Watch Stream' }));
    expect(watchStream).toHaveBeenCalledWith('2');
  });

  it('shows the watched stream', () => {
    inCall({ streams: ['2'], watching: '2' });
    render(<CallPanel user={alice} peer={bob} />);
    expect(screen.getByLabelText("bob's screen")).toBeTruthy();
  });
});

describe('Screen sharing in a group call', () => {
  beforeEach(() => {
    state.call = { id: 'c1', groupId: 9, participants: [1, 2, 3], state: 'active' };
  });

  it('waits for Watch Stream', () => {
    inCall({ streams: ['2'] });
    const names = new Map([[1, 'alice'], [2, 'bob'], [3, 'carol']]);
    render(<GroupCallPanel groupId={9} names={names} user={alice} />);
    expect(watchStream).not.toHaveBeenCalled();
    expect(screen.getByText('bob is sharing their screen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Watch Stream' }));
    expect(watchStream).toHaveBeenCalledWith('2');
    expect(screen.getByRole('button', { name: 'Share your screen' })).toBeTruthy();
  });
});
