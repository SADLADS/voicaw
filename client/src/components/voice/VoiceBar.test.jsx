// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutContext } from '../../contexts';

const state = vi.hoisted(() => ({ voice: {}, call: null }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));
vi.mock('../../hooks/useCall', () => ({ useCall: () => state.call }));
vi.mock('../../voice/voiceClient', () => ({
  clearCameraError() {}, clearStreamError() {}, clearVoiceError() {}, leaveVoice() {}, resumeAudio() {},
}));
vi.mock('../../voice/callClient', () => ({ hangUp() {} }));
vi.mock('./CameraButton', () => ({ default: () => null }));
vi.mock('./ScreenShareButton', () => ({ default: () => null }));
vi.mock('../../utils/profiles', () => ({ useProfiles() {}, displayName: (id) => `user ${id}` }));
vi.mock('../../utils/mobilePanes', () => ({ showContent() {} }));

import VoiceBar from './VoiceBar';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderBar({ at = '/dm/friends', unread = [], muted = [] } = {}) {
  const guildList = { guilds: [], layouts: {}, unread, isMuted: (id) => muted.includes(id) };
  return render(
    <LayoutContext.Provider value={{ guildList, groupList: { groups: [] } }}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="*" element={<><Where /><VoiceBar user={{ id: 1 }} /></>} />
        </Routes>
      </MemoryRouter>
    </LayoutContext.Provider>,
  );
}

const inChannel = { status: 'connected', guildId: 3, channelId: 4, callId: null, canSpeak: true };

afterEach(() => {
  cleanup();
  state.voice = {};
  state.call = null;
});

describe('VoiceBar', () => {
  it('opens and closes the voice channel\'s chat', () => {
    state.voice = inChannel;
    renderBar();
    fireEvent.click(screen.getByRole('link', { name: 'Open chat' }));
    expect(screen.getByTestId('where').textContent).toBe('/guild/3/4?chat=1');
    fireEvent.click(screen.getByRole('link', { name: 'Close chat' }));
    expect(screen.getByTestId('where').textContent).toBe('/guild/3/4');
  });

  it('marks the chat while it has unread messages, unless it\'s open or muted', () => {
    state.voice = inChannel;
    renderBar({ unread: [{ channel_id: 4, guild_id: 3, count: 2, mentions: 0 }] });
    expect(screen.getByRole('link', { name: 'Open chat' }).className).toContain('unread');
    cleanup();
    renderBar({ at: '/guild/3/4?chat=1', unread: [{ channel_id: 4, guild_id: 3, count: 2, mentions: 0 }] });
    expect(screen.getByRole('link', { name: 'Close chat' }).className).not.toContain('unread');
    cleanup();
    renderBar({ unread: [{ channel_id: 4, guild_id: 3, count: 2, mentions: 0 }], muted: [4] });
    expect(screen.getByRole('link', { name: 'Open chat' }).className).not.toContain('unread');
  });

  it('has no chat button in a call (the title opens the conversation)', () => {
    state.voice = { ...inChannel, guildId: null, channelId: null, callId: 'c' };
    state.call = { groupId: 9, peerId: null };
    renderBar();
    expect(screen.queryByRole('link', { name: 'Open chat' })).toBeNull();
  });
});
