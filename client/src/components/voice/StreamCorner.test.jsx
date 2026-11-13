// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const state = vi.hoisted(() => ({ voice: {}, call: null, poppedOut: false }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));
vi.mock('../../hooks/useCall', () => ({ useCall: () => state.call }));
vi.mock('../../hooks/useStreamWindow', () => ({ useStreamWindow: () => (state.poppedOut ? {} : null) }));
vi.mock('../../voice/voiceClient', () => ({ attachStream: () => () => {}, setStreamError() {}, watchStream() {}, focusCamera() {}, showCamera: () => () => {}, participantName: () => '' }));
vi.mock('../../voice/streamWindow', () => ({ closeStreamWindow() {}, openStreamWindow() {} }));
vi.mock('../../utils/profiles', async (importOriginal) => ({ ...(await importOriginal()), useProfiles() {}, displayName: (id) => `user ${id}` }));

import { act } from '@testing-library/react';
import StreamCorner from './StreamCorner';
import StreamView from './StreamView';
import { cornerHolder, leaveCorner, resetCornerSlot, wantCorner } from '../../services/cornerSlot';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderCorner({ page = false } = {}) {
  return render(
    <MemoryRouter initialEntries={['/dm/friends']}>
      <Routes>
        <Route path="*" element={<><Where />{page && <StreamView userId="7" name="user 7" />}<StreamCorner /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

const inChannel = { status: 'connected', guildId: 3, channelId: 4, callId: null, identity: '1', watching: '7', watchingReady: true, selfDeaf: false };

afterEach(() => {
  cleanup();
  resetCornerSlot();
  state.voice = {};
  state.call = null;
  state.poppedOut = false;
});

describe('StreamCorner', () => {
  it('shows a stream no page shows, small, and goes back to its voice channel', () => {
    state.voice = inChannel;
    const { container } = renderCorner();
    expect(container.querySelector('.stream-view.corner')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the voice channel' }));
    expect(screen.getByTestId('where').textContent).toBe('/guild/3/4');
  });

  it('goes back to the call it\'s from', () => {
    state.voice = { ...inChannel, guildId: null, channelId: null, callId: 'c' };
    state.call = { groupId: 9, peerId: null };
    renderCorner();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the call' }));
    expect(screen.getByTestId('where').textContent).toBe('/dm/g/9');
  });

  it('carries a focused camera on, over a stream you watch; never your own', () => {
    state.voice = { ...inChannel, cameras: ['8'], focusedCamera: '8' };
    const { container } = renderCorner();
    expect(container.querySelector('.stream-view.corner.camera')).not.toBeNull();
    expect(screen.getByLabelText("user 8's camera")).toBeTruthy();
    cleanup();
    state.voice = { ...inChannel, cameras: ['1'], focusedCamera: '1' };
    const own = renderCorner();
    expect(own.container.querySelector('.stream-view.corner.camera')).toBeNull();
    expect(screen.getByLabelText("user 7's screen")).toBeTruthy();
  });

  it('waits, sound only, while another player has the corner, and comes once it\'s free', () => {
    wantCorner('video');
    state.voice = inChannel;
    const { container } = renderCorner();
    expect(container.querySelector('.stream-view.corner')).toBeNull();
    act(() => leaveCorner('video'));
    expect(container.querySelector('.stream-view.corner')).not.toBeNull();
    expect(cornerHolder()).toBe('stream');
  });

  it('keeps the corner from a video that comes after it', () => {
    state.voice = inChannel;
    const { container } = renderCorner();
    expect(cornerHolder()).toBe('stream');
    act(() => wantCorner('video'));
    expect(container.querySelector('.stream-view.corner')).not.toBeNull();
    act(() => leaveCorner('video'));
  });

  it('steps aside while a page shows the stream', () => {
    state.voice = inChannel;
    const { container } = renderCorner({ page: true });
    expect(container.querySelectorAll('.stream-view')).toHaveLength(1);
    expect(container.querySelector('.stream-view.corner')).toBeNull();
  });

  it('isn\'t for your own stream, one popped out, or nothing watched', () => {
    state.voice = { ...inChannel, watching: '1' };
    const own = renderCorner();
    expect(own.container.querySelector('.stream-view')).toBeNull();
    cleanup();
    state.voice = inChannel;
    state.poppedOut = true;
    expect(renderCorner().container.querySelector('.stream-view')).toBeNull();
    cleanup();
    state.poppedOut = false;
    state.voice = { ...inChannel, watching: null };
    expect(renderCorner().container.querySelector('.stream-view')).toBeNull();
  });
});
