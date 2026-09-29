// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

import api from '../utils/api';
import Settings from './Settings';
import { InteractionContext } from '../contexts';
import { AuthContext } from '../hooks/useAuth';

function renderSettings({ onLogout = vi.fn(), interactionOverrides = {} } = {}) {
  const setInteractionMode = vi.fn();
  const utils = render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me', hasRecoveryCode: true }, setUser: vi.fn() }}>
      <InteractionContext.Provider
        value={{ interactionMode: 'auto', setInteractionMode, ...interactionOverrides }}
      >
        <Settings onLogout={onLogout} />
      </InteractionContext.Provider>
    </AuthContext.Provider>
  );
  return { ...utils, setInteractionMode, onLogout };
}

function imageFile(name = 'pic.png') {
  return new File(['fake-bytes'], name, { type: 'image/png' });
}

function textFile(name = 'notes.txt') {
  return new File(['fake-text'], name, { type: 'text/plain' });
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn();
});

describe('Settings', () => {
  it('rejects non-image files selected via the file input', () => {
    renderSettings();

    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [textFile()] } });

    expect(screen.getByText('Only image files are allowed.')).toBeInTheDocument();
    expect(screen.getByText('Upload')).toBeDisabled();
  });

  it('accepts an image file and enables the Upload button', () => {
    renderSettings();

    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [imageFile()] } });

    expect(screen.queryByText('Only image files are allowed.')).not.toBeInTheDocument();
    expect(screen.getByText('Upload')).not.toBeDisabled();
  });

  it('uploads the selected file and shows a success message', async () => {
    api.get.mockResolvedValue({ data: { url: 'https://s3.test/signed-put-url' } });
    globalThis.fetch.mockResolvedValue({ ok: true });

    renderSettings();
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [imageFile()] } });
    fireEvent.click(screen.getByText('Upload'));

    await waitFor(() => expect(screen.getByText('Upload successful!')).toBeInTheDocument());

    expect(api.get).toHaveBeenCalledWith('/upload_profile_pic', {
      params: { type: 'image/png', size: 10 },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://s3.test/signed-put-url',
      expect.objectContaining({ method: 'PUT' })
    );
    // File cleared and button disabled again after a successful upload.
    expect(screen.getByText('Upload')).toBeDisabled();
  });

  it('shows an error message when the upload PUT fails', async () => {
    api.get.mockResolvedValue({ data: { url: 'https://s3.test/signed-put-url' } });
    globalThis.fetch.mockResolvedValue({ ok: false });

    renderSettings();
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [imageFile()] } });
    fireEvent.click(screen.getByText('Upload'));

    await waitFor(() => expect(screen.getByText('Upload failed')).toBeInTheDocument());
  });

  it('shows an error message when no signed URL comes back', async () => {
    api.get.mockResolvedValue({ data: {} });

    renderSettings();
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [imageFile()] } });
    fireEvent.click(screen.getByText('Upload'));

    await waitFor(() => expect(screen.getByText('Invalid upload URL')).toBeInTheDocument());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls setInteractionMode when the select changes', () => {
    const { setInteractionMode } = renderSettings();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mobile' } });

    expect(setInteractionMode).toHaveBeenCalledWith('mobile');
  });

  it('calls onLogout when the logout button is clicked', () => {
    const { onLogout } = renderSettings();

    fireEvent.click(screen.getByTitle('Logout'));

    expect(onLogout).toHaveBeenCalled();
  });

  it('rejects profile pictures over 8 MB before uploading', async () => {
    renderSettings();
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });

    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [big] } });

    expect(await screen.findByText('That image is too large (max 8 MB).')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});

