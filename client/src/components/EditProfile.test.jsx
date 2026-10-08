// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

import api from '../utils/api';
import EditProfile from './EditProfile';
import { AuthContext } from '../hooks/useAuth';
import { ConfigContext } from '../contexts';
import { clearProfiles, getProfile, mergeProfiles, setAvatarBase } from '../utils/profiles';

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
// Picks it, and applies the cropper as it opens (a 200×100 picture: the middle square).
async function pickAndCrop(file) {
  pickFile(file);
  fireEvent.load(document.querySelector('.image-cropper-frame img'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}
const MIDDLE = { x: 0.25, y: 0, width: 0.5, height: 1 };
const field = (name) => screen.getByRole('textbox', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.clearAllMocks();
  clearProfiles();
  mergeProfiles([{ id: 1, username: 'alice', display_name: 'Alice', custom_status: null, bio: 'Hi there' }]);
  globalThis.fetch = vi.fn();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 100 });
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

  it('opens a picked picture in the cropper; cancelling leaves the picture as it was', async () => {
    renderPage();
    pickFile(imageFile());
    expect(screen.getByRole('dialog', { name: 'Edit image' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('uploads a picked picture on save (previewing it first), and shows the processed one', async () => {
    setAvatarBase('https://s3.test');
    api.post.mockImplementation(async (url) => (url === '/profile/avatar'
      ? { data: { uploadId: 'up1', url: 'https://s3.test/signed-put-url' } }
      : { data: { id: 1, username: 'alice', display_name: 'Alice', custom_status: null, bio: 'Hi there', avatar: 'new1' } }));
    globalThis.fetch.mockResolvedValue({ ok: true });
    renderPage();
    await pickAndCrop(imageFile());
    expect(screen.getByAltText('Your profile picture')).toHaveAttribute('src', 'blob:preview');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('Profile saved.')).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/profile/avatar', { type: 'image/png', size: 10 });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://s3.test/signed-put-url', expect.objectContaining({ method: 'PUT' }));
    expect(api.post).toHaveBeenCalledWith('/profile/avatar/up1/ready', { crop: MIDDLE });
    expect(api.put).not.toHaveBeenCalled(); // nothing else changed
    expect(getProfile(1).avatar).toBe('new1');
    expect(screen.getByAltText('Your profile picture')).toHaveAttribute('src', 'https://s3.test/profile-pics/1/new1.webp');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('removes your picture on save', async () => {
    mergeProfiles([{ id: 1, username: 'alice', avatar: 'old' }]);
    api.delete.mockResolvedValue({ data: { id: 1, username: 'alice', avatar: null } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByAltText('Your profile picture').getAttribute('src')).not.toContain('s3.test');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Profile saved.')).toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith('/profile/avatar');
    expect(getProfile(1).avatar).toBe(null);
  });

  it('shows upload errors', async () => {
    api.post.mockResolvedValue({ data: {} });
    renderPage();
    await pickAndCrop(imageFile());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Invalid upload URL')).toBeInTheDocument());

    api.post.mockResolvedValue({ data: { uploadId: 'up2', url: 'https://s3.test/signed-put-url' } });
    globalThis.fetch.mockResolvedValue({ ok: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Upload failed')).toBeInTheDocument());

    // The server can't use the image.
    api.post.mockImplementation(async (url) => {
      if (url === '/profile/avatar') return { data: { uploadId: 'up3', url: 'https://s3.test/signed-put-url' } };
      throw Object.assign(new Error('400'), { response: { data: { error: "That file isn't an image we can read" } } });
    });
    globalThis.fetch.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText("That file isn't an image we can read")).toBeInTheDocument());
  });
});
