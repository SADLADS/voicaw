// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const forgetLogin = vi.fn(async () => {});
vi.mock('../services/logout', () => ({ forgetLogin }));
vi.mock('../services/settingsStore', () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) }));

import ServerChoice from './ServerChoice';

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  forgetLogin.mockClear();
  reload.mockClear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href: 'http://localhost:3000/', reload } });
});

function connectTo(address) {
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  fireEvent.change(screen.getByLabelText('Server address'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

describe('ServerChoice', () => {
  it('shows the server the login screen logs in to', () => {
    render(<ServerChoice />);
    expect(screen.getByText(/Server: localhost:3002/)).toBeTruthy();
  });

  it('checks the address, forgets this device\'s login and reloads onto the new server', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ signupMode: 'open', termsVersion: 'x' }) }));
    render(<ServerChoice />);
    connectTo('chat.example.com');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://chat.example.com/api/config');
    expect(forgetLogin).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('server'))).toEqual({ api: 'https://chat.example.com/api/', ws: 'wss://chat.example.com/api/socket' });
  });

  it('stays put when there is no Voicaw server there', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    render(<ServerChoice />);
    connectTo('example.com');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', "Couldn't find a Voicaw server at that address.");
    expect(reload).not.toHaveBeenCalled();
    expect(forgetLogin).not.toHaveBeenCalled();
    expect(localStorage.getItem('server')).toBeNull();
  });
});
