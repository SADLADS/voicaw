// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

import api from '../utils/api';
import EditProfile from './EditProfile';
import { AuthContext } from '../hooks/useAuth';
import { ConfigContext } from '../contexts';
import { clearProfiles, getProfile, mergeProfiles } from '../utils/profiles';

const me = { id: 1, username: 'alice', hasRecoveryCode: true };

function renderPage() {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
      <AuthContext.Provider value={{ user: me, setUser: vi.fn() }}>
        <EditProfile />
      </AuthContext.Provider>
    </ConfigContext.Provider>
  );
}

const imageFile = (name = 'pic.png') => new File(['fake-bytes'], name, { type: 'image/png' });
const pickFile = (file) => fireEvent.change(screen.getByLabelText('Choose a profile picture'), { target: { files: [file] } });
const field = (name) => screen.getByRole('textbox', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.clearAllMocks();
  clearProfiles();
  mergeProfiles([{ id: 1, username: 'alice', display_name: 'Alice', custom_status: null, bio: 'Hi there' }]);
  globalThis.fetch = vi.fn();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('EditProfile', () => {
  it('starts from your saved profile, and previews changes before saving', () => {
    renderPage();
    expect(field('Display name')).toHaveValue('Alice');
    expect(field('About me')).toHaveValue('Hi there');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.change(field('Custom status'), { target: { value: 'Down the rabbit hole' } });
    const preview = document.querySelector('.edit-profile-preview');
    expect(preview).toHaveTextContent('Down the rabbit hole');
    expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(field('Custom status')).toHaveValue('');
    expect(preview).not.toHaveTextContent('Down the rabbit hole');
  });

  it("saves only what changed, and updates everyone's view of you", async () => {
    api.put.mockResolvedValue({ data: { id: 1, username: 'alice', display_name: 'Ally', custom_status: 'busy', bio: 'Hi there' } });
    renderPage();
    fireEvent.change(field('Display name'), { target: { value: '  Ally ' } });
    fireEvent.change(field('Custom status'), { target: { value: 'busy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('Profile saved.')).toBeInTheDocument());
    expect(api.put).toHaveBeenCalledWith('/profile', { displayName: 'Ally', customStatus: 'busy' });
    expect(getProfile(1)).toMatchObject({ display_name: 'Ally', custom_status: 'busy' });
    expect(api.get).not.toHaveBeenCalled(); // no picture to upload
  });

  it('rejects non-images and pictures over 8 MB', () => {
    renderPage();
    pickFile(new File(['text'], 'notes.txt', { type: 'text/plain' }));
    expect(screen.getByText('Only image files are allowed.')).toBeInTheDocument();
    pickFile(new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }));
    expect(screen.getByText('That image is too large (max 8 MB).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('uploads a picked picture on save, previewing it first', async () => {
    api.get.mockResolvedValue({ data: { url: 'https://s3.test/signed-put-url' } });
    globalThis.fetch.mockResolvedValue({ ok: true });
    renderPage();
    pickFile(imageFile());
    expect(screen.getByAltText('Your profile picture')).toHaveAttribute('src', 'blob:preview');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('Profile saved.')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/upload_profile_pic', { params: { type: 'image/png', size: 10 } });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://s3.test/signed-put-url', expect.objectContaining({ method: 'PUT' }));
    expect(api.put).not.toHaveBeenCalled(); // nothing else changed
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('shows upload errors', async () => {
    api.get.mockResolvedValue({ data: {} });
    renderPage();
    pickFile(imageFile());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Invalid upload URL')).toBeInTheDocument());

    api.get.mockResolvedValue({ data: { url: 'https://s3.test/signed-put-url' } });
    globalThis.fetch.mockResolvedValue({ ok: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Upload failed')).toBeInTheDocument());
  });
});
