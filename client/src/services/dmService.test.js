import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../utils/api';
import {
  fetchUsersList,
  fetchMessagesForUser,
  sendMessageToUser,
  markMessagesRead,
} from './dmService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchUsersList', () => {
  it('GETs /dms-list and returns the response body', async () => {
    api.get.mockResolvedValue({ data: [{ id: 1, username: 'alice' }] });

    const result = await fetchUsersList();

    expect(api.get).toHaveBeenCalledWith('/dms-list');
    expect(result).toEqual([{ id: 1, username: 'alice' }]);
  });
});

describe('fetchMessagesForUser', () => {
  it('GETs /dm-messages/:userId with optional query params', async () => {
    api.get.mockResolvedValue({ data: [] });

    await fetchMessagesForUser(42, { before: 100 });

    expect(api.get).toHaveBeenCalledWith('/dm-messages/42', { params: { before: 100 } });
  });

  it('defaults params to an empty object', async () => {
    api.get.mockResolvedValue({ data: [] });

    await fetchMessagesForUser(42);

    expect(api.get).toHaveBeenCalledWith('/dm-messages/42', { params: {} });
  });
});

describe('sendMessageToUser', () => {
  it('POSTs recipient, content, replyTo and the uploads it shows to /dm-send', async () => {
    api.post.mockResolvedValue({ data: { id: 1, content: 'hi' } });

    const result = await sendMessageToUser(7, 'hi', 3, ['a.bin']);

    expect(api.post).toHaveBeenCalledWith('/dm-send', {
      recipient_id: 7,
      content: 'hi',
      replyTo: 3,
      uploads: ['a.bin'],
    });
    expect(result).toEqual({ id: 1, content: 'hi' });
  });

  it('defaults replyTo to null', async () => {
    api.post.mockResolvedValue({ data: {} });

    await sendMessageToUser(7, 'hi');

    expect(api.post).toHaveBeenCalledWith('/dm-send', {
      recipient_id: 7,
      content: 'hi',
      replyTo: null,
      uploads: [],
    });
  });
});

describe('markMessagesRead', () => {
  it('POSTs to /dm-mark-read/:userId', async () => {
    api.post.mockResolvedValue({ data: { success: true } });

    await markMessagesRead(9);

    expect(api.post).toHaveBeenCalledWith('/dm-mark-read/9');
  });
});
