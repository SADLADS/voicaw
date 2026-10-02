import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/api', () => ({ default: { post: vi.fn(() => Promise.resolve({})) } }));
vi.mock('../utils/privacy', () => ({ getPrivacyPrefs: vi.fn(() => ({ sendTyping: true })) }));

const { default: api } = await import('../utils/api');
const { getPrivacyPrefs } = await import('../utils/privacy');
const { noteTyping, typingDone, RESEND_MS, RETRY_MS } = await import('./typingService');

describe('noteTyping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.post.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('tells the server at most every few seconds per chat, and again after sending', () => {
    noteTyping('group-x');
    noteTyping('group-x');
    noteTyping(12);
    expect(api.post.mock.calls).toEqual([['/typing', { chatId: 'group-x' }], ['/typing', { chatId: '12' }]]);
    vi.advanceTimersByTime(RESEND_MS);
    noteTyping('group-x');
    expect(api.post).toHaveBeenCalledTimes(3);
    typingDone('group-x');
    noteTyping('group-x');
    expect(api.post).toHaveBeenCalledTimes(4);
  });

  it('tries again a second later when the server says it was too soon', async () => {
    const tooSoon = () => Promise.reject(Object.assign(new Error('429'), { response: { status: 429 } }));
    api.post.mockImplementationOnce(tooSoon);
    noteTyping('channel-3');
    await vi.advanceTimersByTimeAsync(500);
    noteTyping('channel-3');
    expect(api.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(api.post.mock.calls).toEqual([['/typing', { chatId: 'channel-3' }], ['/typing', { chatId: 'channel-3' }]]);

    // Not once the message is sent (or the box emptied).
    api.post.mockImplementationOnce(tooSoon);
    typingDone('channel-3');
    noteTyping('channel-3');
    await vi.advanceTimersByTimeAsync(10);
    typingDone('channel-3');
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(api.post).toHaveBeenCalledTimes(3);
  });

  it('never for notes, nor when turned off in Privacy', () => {
    noteTyping('notes');
    getPrivacyPrefs.mockReturnValueOnce({ sendTyping: false });
    noteTyping('channel-9');
    expect(api.post).not.toHaveBeenCalled();
  });
});
