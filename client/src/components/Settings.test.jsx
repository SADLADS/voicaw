// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

// Have their own tests (AdminSettings.test.jsx, DeviceSettings.test.jsx).
vi.mock('./AdminSettings', () => ({ default: () => null }));
vi.mock('./DeviceSettings', () => ({ default: () => null }));

import api from '../utils/api';
import Settings from './Settings';
import { applyAdminAlerts } from '../utils/adminAlerts';
import { onOpenUserProfile } from '../utils/userProfile';
import { AuthContext } from '../hooks/useAuth';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.hash}</output>;
}

function renderSettings({ onLogout = vi.fn(), at = '/settings' } = {}) {
  const utils = render(
    <AuthContext.Provider value={{ user: { id: 1, username: 'me', hasRecoveryCode: true }, setUser: vi.fn() }}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/settings/*" element={<Settings onLogout={onLogout} />} />
          <Route path="/developers" element={<p>Developer portal page</p>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </AuthContext.Provider>
  );
  return { ...utils, onLogout };
}

const where = () => screen.getByTestId('where').textContent;
const nav = () => screen.getByRole('navigation', { name: 'Settings sections' });
const navItems = () => [...nav().querySelectorAll('.settings-nav-item')].map((e) => e.textContent);
const navSubs = () => [...nav().querySelectorAll('.settings-nav-sub')].map((e) => e.textContent);
const pageTitle = () => document.querySelector('.settings-page-title')?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockRejectedValue({ response: { status: 403 } });
  globalThis.fetch = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('Settings pages', () => {
  it('lists the pages in groups, then About, Developer Portal and Log Out', () => {
    renderSettings();
    expect([...nav().querySelectorAll('.settings-nav-category')].map((e) => e.textContent)).toEqual(['User Settings', 'App Settings']);
    expect(navItems()).toEqual([
      'My Account', 'Privacy & Safety', 'Notifications',
      'Appearance', 'Language & Region', 'Voice & Video',
      'About', 'Developer Portal', 'Log Out',
    ]);
    expect(screen.queryByText(/bot api docs/i)).toBeNull();
  });

  it('opens on My Account, its subsections under it and no other page\'s', () => {
    renderSettings();
    expect(pageTitle()).toBe('My Account');
    expect(screen.getByRole('button', { name: 'My Account' })).toHaveAttribute('aria-current', 'page');
    expect(navSubs()).toEqual(['Password', 'Recovery code', 'Two-factor authentication', 'Devices', 'Delete account']);
    expect(screen.queryByLabelText('Date format')).toBeNull();
  });

  it('a page opens on its own, and a subsection scrolls to its part', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Language & Region' }));
    expect(where()).toBe('/settings/language');
    expect(pageTitle()).toBe('Language & Region');
    expect(screen.getByLabelText('Date format')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Current password')).toBeNull();
    expect(navSubs()).toEqual(['Language', 'Date & time', 'Spellcheck']);
    const scroll = vi.fn();
    document.getElementById('settings-date-time').scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('button', { name: 'Date & time' }));
    expect(where()).toBe('/settings/language#date-time');
    expect(scroll).toHaveBeenCalled();
  });

  it('shows no subsections for a page with only one', () => {
    renderSettings({ at: '/settings/appearance' });
    expect(pageTitle()).toBe('Appearance');
    expect(navSubs()).toEqual([]);
  });

  it('takes the old one-page Settings\' links to the page holding that section', async () => {
    renderSettings({ at: '/settings#date-time' });
    await waitFor(() => expect(where()).toBe('/settings/language#date-time'));
    expect(screen.getByLabelText('Date format')).toBeInTheDocument();
  });

  it('takes an old link to a section that was split or renamed by its alias', async () => {
    renderSettings({ at: '/settings#account-security' });
    await waitFor(() => expect(where()).toBe('/settings/account#password'));
  });

  it('asks before logging out', () => {
    const { onLogout } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByText('Are you sure you want to log out?')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Log Out' }).find((b) => b.classList.contains('btn-danger')));
    expect(onLogout).toHaveBeenCalled();
  });

  it('Developer Portal goes to the portal, with no page in Settings', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Developer Portal' }));
    expect(screen.getByText('Developer portal page')).toBeInTheDocument();
  });

  it('lists Admin and Reports for admins', async () => {
    api.get.mockResolvedValue({ data: { settings: [] } });
    renderSettings();
    await waitFor(() => expect(navItems()).toContain('Admin'));
    expect(navItems()).toContain('Reports');
  });

  it("counts what's waiting beside Admin and Reports, and their subsections", async () => {
    api.get.mockResolvedValue({ data: { settings: [] } });
    act(() => applyAdminAlerts({ reports: 2, signups: 1, testers: 3 }));
    renderSettings({ at: '/settings/admin' });
    await waitFor(() => expect(navItems()).toContain('Admin4'));
    expect(navItems()).toContain('Reports2');
    expect(screen.getByRole('button', { name: 'Sign-ups4' })).toBeInTheDocument();
    act(() => applyAdminAlerts({ reports: 0, signups: 0, testers: 0 }));
    expect(navItems()).toContain('Admin');
    expect(navItems()).toContain('Reports');
    act(() => applyAdminAlerts(null));
  });
});

describe('Settings search and date formats', () => {
  it('search lists the matching subsections with their page, and opens one', () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: '24-hour' } });
    const results = [...nav().querySelectorAll('.settings-nav-result')];
    expect(results.map((e) => e.textContent)).toEqual(['Date & timeLanguage & Region']);
    expect(navItems()).not.toContain('Log Out');
    fireEvent.click(results[0]);
    expect(where()).toBe('/settings/language#date-time');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No settings match “zzz”.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(navItems()).toContain('My Account');
  });

  it('search finds subsections inside one page\'s card', () => {
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'webcam' } });
    expect([...nav().querySelectorAll('.settings-nav-result-title')].map((e) => e.textContent)).toEqual(['Camera']);
  });

  it('has your name and Edit Profile above the search, whatever is searched, opening your full profile', () => {
    const opened = vi.fn();
    const stop = onOpenUserProfile(opened);
    renderSettings();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } });
    const link = screen.getByRole('button', { name: /me\s*Edit Profile/ });
    expect(link.compareDocumentPosition(screen.getByRole('searchbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(navItems()).not.toContain('Edit Profile');
    fireEvent.click(link);
    expect(opened).toHaveBeenCalledTimes(1);
    stop();
  });

  it('opens your full profile for the old Edit Profile address, over Settings', () => {
    const opened = vi.fn();
    const stop = onOpenUserProfile(opened);
    renderSettings({ at: '/settings/profile' });
    expect(opened).toHaveBeenCalledTimes(1);
    stop();
  });

  it('changes the date and time formats', () => {
    renderSettings({ at: '/settings/language' });
    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'ymd' } });
    fireEvent.change(screen.getByLabelText('Time format'), { target: { value: '24' } });
    expect(JSON.parse(localStorage.getItem('dateFormat'))).toEqual({ date: 'ymd', time: '24' });
    expect(screen.getByText(/Messages will show: \d{4}-\d{2}-\d{2}, \d{2}:\d{2}\./)).toBeInTheDocument();
  });

  it('turns spellcheck off and on for this device', () => {
    localStorage.removeItem('spellcheck');
    renderSettings({ at: '/settings/language' });
    const box = screen.getByRole('checkbox', { name: 'Check spelling as you type' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(document.documentElement.spellcheck).toBe(false);
    expect(localStorage.getItem('spellcheck')).toBe('off');
    fireEvent.click(box);
    expect(document.documentElement.spellcheck).toBe(true);
  });
});
