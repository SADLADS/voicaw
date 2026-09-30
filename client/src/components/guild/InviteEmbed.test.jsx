// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LayoutContext } from '../../contexts';
import UrlPreviews from '../UrlPreviews';
import { acceptInvite, fetchInvitePreview } from '../../services/guildService';

vi.mock('../../services/guildService', () => ({
  fetchInvitePreview: vi.fn(),
  invitePreviewRequested: vi.fn(() => false),
  acceptInvite: vi.fn(),
}));

const INVITE = { code: 'Ab3dEf7h', guild_id: 7, name: 'Book Club', icon_version: 0, member_count: 3, is_member: false };
const LINK = 'come join https://voicaw.com/invite/Ab3dEf7h';

function renderPreviews(props, guilds = []) {
  const guildList = { loaded: true, guilds, upsertGuild: vi.fn() };
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

  it('asks the server only once tapped in encrypted chats', async () => {
    renderPreviews({ text: LINK, encrypted: true });
    expect(screen.getByText('Guild invite')).toBeInTheDocument();
    expect(fetchInvitePreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(fetchInvitePreview).toHaveBeenCalledWith('Ab3dEf7h');
  });

  it('says when an invite is invalid', async () => {
    fetchInvitePreview.mockRejectedValue({ response: { status: 404 } });
    renderPreviews({ text: LINK, encrypted: false });
    expect(await screen.findByText('Invalid invite')).toBeInTheDocument();
  });

  it('embeds each invite once and ignores other sites', () => {
    renderPreviews({
      text: `${LINK} ${LINK}/ https://example.com/invite/Zz9yXx8w`,
      encrypted: true,
    });
    expect(screen.getAllByText('Guild invite')).toHaveLength(1);
  });
});
