// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import api from './api';

// Runs a request through the real interceptors, with a stand-in for the network that can do
// something (log out, log in as someone else) while the request is out.
function requestWith(headers, meanwhile = () => {}) {
  return api.get('/profile', {
    adapter: async (config) => {
      meanwhile();
      return { data: {}, status: 200, statusText: 'OK', headers, config };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'old');
});

describe('api token renewal', () => {
  it('stores a renewed token', async () => {
    await requestWith({ 'x-voicaw-token': 'new' });
    expect(localStorage.getItem('token')).toBe('new');
  });

  it('leaves the token alone without one', async () => {
    await requestWith({});
    expect(localStorage.getItem('token')).toBe('old');
  });

  it('does not bring a token back after logging out', async () => {
    await requestWith({ 'x-voicaw-token': 'new' }, () => localStorage.removeItem('token'));
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('ignores a renewal of a different login', async () => {
    await requestWith({ 'x-voicaw-token': 'new' }, () => localStorage.setItem('token', 'second'));
    expect(localStorage.getItem('token')).toBe('second');
  });
});
