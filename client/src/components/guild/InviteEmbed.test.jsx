// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LayoutContext } from '../../contexts';
import UrlPreviews from '../UrlPreviews';
import { acceptInvite, fetchEvent, fetchInvitePreview } from '../../services/guildService';
import { setPrivacyPref } from '../../utils/privacy';

vi.mock('../../services/guildService', () => ({
  fetchInvitePreview: vi.fn(),
  invitePreviewRequested: vi.fn(() => false),
  acceptInvite: vi.fn(),
  fetchEvent: vi.fn(),
  setEventInterest: vi.fn(),
}));
vi.mock('../../utils/ws-client', () => ({ onGuildEvent: () => () => {} }));

const INVITE = { code: 'Ab3dEf7h', guild_id: 7, name: 'Book Club', icon_version: 0, member_count: 3, is_member: false };
const LINK = 'come join https://voicaw.com/invite/Ab3dEf7h';

function renderPreviews(props, guilds = []) {
  const guildList = { loaded: true, guilds, layouts: {}, upsertGuild: vi.fn() };
  render(
    <LayoutContext.Provider value={{ guildList }}>
      <MemoryRouter initialEntries={['/dm/1']}>
        <Routes>
          <Route path="/dm/:id" element={<UrlPreviews {...props} />} />
          <Route path="/guild/:guildId" element={<p>guild page</p>} />
        </Routes>
      </MemoryRouter>
    </LayoutContext.Provider>
  );
  return guildList;
}

describe('invite embeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchInvitePreview.mockResolvedValue(INVITE);
  });

  it('shows the guild with Join Guild, and joins', async () => {
    acceptInvite.mockResolvedValue({ id: 7, name: 'Book Club' });
    const guildList = renderPreviews({ text: LINK, encrypted: false });
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join Guild' }));
    expect(await screen.findByText('guild page')).toBeInTheDocument();
    expect(acceptInvite).toHaveBeenCalledWith('Ab3dEf7h');
    expect(guildList.upsertGuild).toHaveBeenCalledWith({ id: 7, name: 'Book Club' });
  });

  it('offers Go to Guild to members', async () => {
    renderPreviews({ text: LINK, encrypted: false }, [{ id: 7, name: 'Book Club' }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Go to Guild' }));
    expect(await screen.findByText('guild page')).toBeInTheDocument();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('loads at once in encrypted chats by default', async () => {
    renderPreviews({ text: LINK, encrypted: true });
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument();
  });

  describe('with Settings → Privacy turned off', () => {
    beforeEach(() => setPrivacyPref('inviteEmbedsInEncrypted', false));
    afterEach(() => setPrivacyPref('inviteEmbedsInEncrypted', true));

    it('asks the server only once tapped in encrypted chats', async () => {
      renderPreviews({ text: LINK, encrypted: true });
      expect(screen.getByText('Guild invite')).toBeInTheDocument();
      expect(fetchInvitePreview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(await screen.findByText('Book Club')).toBeInTheDocument();
      expect(fetchInvitePreview).toHaveBeenCalledWith('Ab3dEf7h');
    });

    it('loads waiting cards as soon as it is turned back on', async () => {
      renderPreviews({ text: LINK, encrypted: true });
      expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
      act(() => setPrivacyPref('inviteEmbedsInEncrypted', true));
      expect(await screen.findByText('Book Club')).toBeInTheDocument();
    });

    it('embeds each invite once and ignores other sites', () => {
      renderPreviews({
        text: `${LINK} ${LINK}/ https://example.com/invite/Zz9yXx8w`,
        encrypted: true,
      });
      expect(screen.getAllByText('Guild invite')).toHaveLength(1);
    });
  });

  it('says when an invite is invalid', async () => {
    fetchInvitePreview.mockRejectedValue({ response: { status: 404 } });
    renderPreviews({ text: LINK, encrypted: false });
    expect(await screen.findByText('Invalid invite')).toBeInTheDocument();
  });
});

describe('event embeds', () => {
  const EVENT = { id: 34, guild_id: 7, name: 'Movie night', status: 'scheduled', start_time: 2000000000, entity_type: 'external', location: 'Online', user_count: 2, interested: false };
  const EVENT_LINK = 'tonight https://app.voicaw.com/guild/7?event=34';

  beforeEach(() => {
    vi.clearAllMocks();
    fetchEvent.mockResolvedValue(EVENT);
  });

  it('shows the event in encrypted chats too, and View opens it', async () => {
    renderPreviews({ text: EVENT_LINK, encrypted: true });
    expect(await screen.findByText('Movie night')).toBeInTheDocument();
    expect(fetchEvent).toHaveBeenCalledWith(34, { on: null });
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('guild page')).toBeInTheDocument();
  });

  it('asks the server only once tapped with Settings → Privacy turned off', async () => {
    setPrivacyPref('inviteEmbedsInEncrypted', false);
    try {
      renderPreviews({ text: EVENT_LINK, encrypted: true });
      expect(fetchEvent).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(await screen.findByText('Movie night')).toBeInTheDocument();
      expect(fetchEvent).toHaveBeenCalledWith(34, { on: null });
    } finally {
      setPrivacyPref('inviteEmbedsInEncrypted', true);
    }
  });
});
