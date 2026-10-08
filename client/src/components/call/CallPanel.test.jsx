// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({ voice: {}, call: null, groupCall: null }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));
vi.mock('../../hooks/useCall', () => ({ useCall: () => state.call, useGroupCall: () => state.groupCall }));
vi.mock('../../hooks/useStreamWindow', () => ({ useStreamWindow: () => null }));
vi.mock('../../voice/callClient', () => ({ hangUp() {}, joinGroupCallById() {} }));
vi.mock('../../voice/voiceClient', async (importOriginal) => ({
  ...(await importOriginal()),
  watchStream: vi.fn(),
  attachStream: () => () => {},
  canShareScreen: () => true,
}));

import CallPanel from './CallPanel';
import GroupCallPanel from '../group/GroupCallPanel';
import { watchStream } from '../../voice/voiceClient';

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
