// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

// Has its own tests (AdminSettings.test.jsx).
vi.mock('./AdminSettings', () => ({ default: () => null }));

import api from '../utils/api';
import Settings from './Settings';
import { InteractionContext } from '../contexts';
import { AuthContext } from '../hooks/useAuth';
import { MemoryRouter } from 'react-router-dom';

function renderSettings({ onLogout = vi.fn(), interactionOverrides = {} } = {}) {
  const setInteractionMode = vi.fn();
  const utils = render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me', hasRecoveryCode: true }, setUser: vi.fn() }}>
      <InteractionContext.Provider
        value={{ interactionMode: 'auto', setInteractionMode, ...interactionOverrides }}
      >
        <MemoryRouter><Settings onLogout={onLogout} /></MemoryRouter>
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

    fireEvent.change(screen.getByRole('combobox', { name: 'Interaction mode' }), { target: { value: 'mobile' } });

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

describe('Settings layout, search and date formats', () => {
  it('groups sections in categories, and a link jumps to its section', () => {
    renderSettings();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect([...nav.querySelectorAll('.settings-nav-category')].map((e) => e.textContent)).toEqual(['My Account', 'App Settings', 'About']);
    const scroll = vi.fn();
    document.getElementById('settings-date-time').scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('button', { name: 'Date & time' }));
    expect(scroll).toHaveBeenCalled();
  });

  it('search hides the sections that do not match, keeping them in the page', () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: '24-hour' } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect([...nav.querySelectorAll('.settings-nav-item')].map((e) => e.textContent)).toEqual(['Date & time']);
    expect(document.getElementById('settings-date-time')).not.toHaveAttribute('hidden');
    expect(document.getElementById('settings-profile-picture')).toHaveAttribute('hidden');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No settings match “zzz”.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(document.getElementById('settings-profile-picture')).not.toHaveAttribute('hidden');
  });

  it('changes the date and time formats', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'ymd' } });
    fireEvent.change(screen.getByLabelText('Time format'), { target: { value: '24' } });
    expect(JSON.parse(localStorage.getItem('dateFormat'))).toEqual({ date: 'ymd', time: '24' });
    expect(screen.getByText(/Messages will show: \d{4}-\d{2}-\d{2}, \d{2}:\d{2}\./)).toBeInTheDocument();
  });
});
