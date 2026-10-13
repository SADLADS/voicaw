// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/profileService', () => ({
  fetchUserProfile: vi.fn(),
  pictureFileError: () => null,
  removeBanner: vi.fn(),
  removeProfilePicture: vi.fn(),
  updateProfile: vi.fn(async (changes) => ({ id: 1, username: 'ann', bio: changes.bio })),
  uploadBanner: vi.fn(),
  uploadProfilePicture: vi.fn(),
}));

import UserProfile from './UserProfile';
import { ImageViewerContext } from '../contexts';
import { fetchUserProfile, updateProfile } from '../services/profileService';
import { getProfile, mergeProfiles, setAvatarBase } from '../utils/profiles';

setAvatarBase('https://s3.test');
mergeProfiles([
  { id: 1, username: 'ann', bio: null },
  { id: 4, username: 'bob', display_name: 'Bob', avatar: 'pic', bio: 'Hello there', banner: 'wide', banner_color: 0x112233 },
]);

const openImage = vi.fn();
function show(userId, data, props = {}) {
  fetchUserProfile.mockResolvedValue(data);
  const onClose = vi.fn();
  const onOpenProfile = vi.fn();
  render(
    <MemoryRouter>
      <ImageViewerContext.Provider value={{ openImage }}>
        <UserProfile userId={userId} me={1} onClose={onClose} onOpenProfile={onOpenProfile} {...props} />
      </ImageViewerContext.Provider>
    </MemoryRouter>
  );
  return { onClose, onOpenProfile };
}
const tabs = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

beforeEach(() => vi.clearAllMocks());

describe('UserProfile', () => {
  it("shows someone's banner, bio and tabs; the picture opens in the image viewer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { onOpenProfile, onClose } = show(4, {
      memberSince: 1700000000,
      activity: [{ name: 'Hades', seconds: 12000, lastPlayed: now - 3600, sessions: 2, playing: false }],
      mutualFriends: [{ id: 7, username: 'cal' }],
      mutualGuilds: [{ id: 3, name: 'Shared', icon_version: 0 }],
    });
    const dialog = screen.getByRole('dialog', { name: 'Profile of Bob' });
    expect(dialog.querySelector('.user-profile-banner img').src).toBe('https://s3.test/profile-pics/4/banner-wide.webp');
    expect(within(dialog).getByText('Hello there')).toBeInTheDocument();
    await waitFor(() => expect(tabs()).toEqual(['About me', 'Activity', 'Mutual friends (1)', 'Mutual guilds (1)']));
    expect(within(dialog).getByText('Voicaw member since')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View profile picture' }));
    expect(openImage).toHaveBeenCalledWith({ images: [expect.objectContaining({ src: 'https://s3.test/profile-pics/4/pic.webp' })], index: 0 });

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Hades')).toBeInTheDocument();
    expect(screen.getByText('3 h 20 min')).toBeInTheDocument();
    expect(screen.getByText(/Last played/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Mutual friends (1)' }));
    fireEvent.click(screen.getByText('cal'));
    expect(onOpenProfile).toHaveBeenCalledWith(7);
    expect(getProfile(7).username).toBe('cal');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    // Not yours: nothing to edit.
    expect(screen.queryByRole('button', { name: 'Change profile picture' })).toBeNull();
  });

  it("leaves out the tabs they hide", async () => {
    show(4, { memberSince: null, activity: null, mutualFriends: null, mutualGuilds: [] });
    await waitFor(() => expect(tabs()).toEqual(['About me', 'Mutual guilds (0)']));
  });

  it('lets you edit your own in place, and says when your activity is off', async () => {
    show(1, { memberSince: 1700000000, activity: [], mutualFriends: null, mutualGuilds: null, hidden: { activity: true } });
    expect(screen.getByRole('button', { name: 'Change profile picture' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change banner image' })).toBeInTheDocument();
    expect(screen.getByLabelText('Banner colour')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit about me' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'About me' }), { target: { value: 'New bio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ bio: 'New bio' }));
    await waitFor(() => expect(screen.getByText('New bio')).toBeInTheDocument());

    await waitFor(() => expect(tabs()).toEqual(['About me', 'Activity']));
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText(/Your activity history is off/)).toBeInTheDocument();
  });
});
