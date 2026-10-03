// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

// Have their own tests (AdminSettings.test.jsx, DeviceSettings.test.jsx).
vi.mock('./AdminSettings', () => ({ default: () => null }));
vi.mock('./DeviceSettings', () => ({ default: () => null }));

import Settings from './Settings';
import { AuthContext } from '../hooks/useAuth';
import { MemoryRouter } from 'react-router-dom';

function renderSettings({ onLogout = vi.fn() } = {}) {
  const utils = render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me', hasRecoveryCode: true }, setUser: vi.fn() }}>
      <MemoryRouter><Settings onLogout={onLogout} /></MemoryRouter>
    </AuthContext.Provider>
  );
  return { ...utils, onLogout };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn();
});

describe('Settings', () => {
  it('has no interaction mode choice (the layout follows the device)', () => {
    renderSettings();
    expect(screen.queryByText(/interaction mode/i)).toBeNull();
  });

  it('calls onLogout when the logout button is clicked', () => {
    const { onLogout } = renderSettings();

    fireEvent.click(screen.getByTitle('Logout'));

    expect(onLogout).toHaveBeenCalled();
  });

});

describe('Settings layout, search and date formats', () => {
  it('groups sections in categories, and a link jumps to its section', () => {
    renderSettings();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect([...nav.querySelectorAll('.settings-nav-category')].map((e) => e.textContent)).toEqual(['My Account', 'App Settings', 'Developers', 'About']);
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
    expect(document.getElementById('settings-account-security')).toHaveAttribute('hidden');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No settings match “zzz”.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(document.getElementById('settings-account-security')).not.toHaveAttribute('hidden');
  });

  it('has your name and Edit Profile above the search, whatever is searched', () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } });
    const link = screen.getByRole('button', { name: /me\s*Edit Profile/ });
    expect(link.compareDocumentPosition(screen.getByRole('searchbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...document.querySelectorAll('.settings-nav-item')].map((e) => e.textContent)).not.toContain('Edit Profile');
  });

  it('changes the date and time formats', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'ymd' } });
    fireEvent.change(screen.getByLabelText('Time format'), { target: { value: '24' } });
    expect(JSON.parse(localStorage.getItem('dateFormat'))).toEqual({ date: 'ymd', time: '24' });
    expect(screen.getByText(/Messages will show: \d{4}-\d{2}-\d{2}, \d{2}:\d{2}\./)).toBeInTheDocument();
  });
  it('turns spellcheck off and on for this device', () => {
    localStorage.removeItem('spellcheck');
    renderSettings();
    const box = screen.getByRole('checkbox', { name: 'Check spelling as you type' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(document.documentElement.spellcheck).toBe(false);
    expect(localStorage.getItem('spellcheck')).toBe('off');
    fireEvent.click(box);
    expect(document.documentElement.spellcheck).toBe(true);
  });
});
