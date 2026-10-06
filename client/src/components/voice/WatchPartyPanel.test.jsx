// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ party: null, prefs: { youtubeEmbeds: true } }));
const calls = vi.hoisted(() => ({ addVideo: vi.fn(), searchVideos: vi.fn() }));
vi.mock('../../voice/watchParty', async (importOriginal) => ({
  ...(await importOriginal()),
  useWatchParty: () => state.party,
  useWatchPartyLog: () => [],
  addVideo: calls.addVideo,
  searchVideos: calls.searchVideos,
}));
vi.mock('../../utils/privacy', () => ({ usePrivacyPrefs: () => state.prefs }));
vi.mock('../../utils/profiles', () => ({ useProfiles: () => {}, displayName: () => 'alice' }));

import WatchPartyPanel from './WatchPartyPanel';
import { PERMISSIONS } from '../../utils/permissions';

const guild = { id: 1 };
const channel = { id: 2, my_permissions: String(PERMISSIONS.QUEUE_VIDEOS) };
const found = [
  { video_id: 'aaaaaaaaaaa', title: 'Cats at play', author: 'Cat channel', duration: 75, live: false },
  { video_id: 'bbbbbbbbbbb', title: 'Cat radio', author: 'Radio', duration: null, live: true },
];

function type(text) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search YouTube or paste a link' }), { target: { value: text } });
}

describe('WatchPartyPanel search', () => {
  beforeEach(() => {
    state.party = null;
    state.prefs = { youtubeEmbeds: true };
    calls.addVideo.mockReset().mockResolvedValue(null);
    calls.searchVideos.mockReset().mockResolvedValue(found);
  });

  it('adds a link straight away, and searches for anything else', async () => {
    render(<WatchPartyPanel guild={guild} channel={channel} myId={7} />);
    type('https://youtu.be/ccccccccccc');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls.addVideo).toHaveBeenCalledWith(1, 2, 'ccccccccccc'));
    expect(calls.searchVideos).not.toHaveBeenCalled();

    type('https://vimeo.com/123');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('alert').textContent).toBe("That isn't a YouTube video link.");

    type('cats');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(calls.searchVideos).toHaveBeenCalledWith(1, 2, 'cats');
    expect(await screen.findByText('Cats at play')).toBeTruthy();
    expect(screen.getByText('Cat channel · 1:15')).toBeTruthy();
    expect(screen.getByText('Radio · Live')).toBeTruthy();
    expect(document.querySelectorAll('.watch-party-result-thumb')).toHaveLength(2);
  });

  it('adds results one by one, marking them added', async () => {
    state.party = { current: { id: 1, video_id: 'zzzzzzzzzzz', title: 'Playing', added_by: 7 }, queue: [], playing: true };
    render(<WatchPartyPanel guild={guild} channel={channel} myId={7} />);
    type('cats');
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Cats at play to the queue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cats at play was added' }).disabled).toBe(true));
    expect(calls.addVideo).toHaveBeenCalledWith(1, 2, 'aaaaaaaaaaa');
    expect(screen.getByRole('button', { name: 'Add Cat radio to the queue' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close the search results' }));
    expect(screen.queryByText('Cat radio')).toBeNull();
  });

  it('says when nothing was found or YouTube failed, and shows no thumbnails if YouTube waits', async () => {
    state.prefs = { youtubeEmbeds: false };
    render(<WatchPartyPanel guild={guild} channel={channel} myId={7} />);
    type('cats');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Cats at play');
    expect(document.querySelectorAll('.watch-party-result-thumb')).toHaveLength(0);

    calls.searchVideos.mockResolvedValueOnce([]);
    type('nothing');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No videos found.')).toBeTruthy();

    calls.searchVideos.mockRejectedValueOnce({ response: { data: { error: "YouTube couldn't be searched." } } });
    type('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findByRole('alert')).textContent).toBe("YouTube couldn't be searched.");
  });

  it("keeps the box focused when its buttons are pressed (a phone's layout moves otherwise)", () => {
    render(<WatchPartyPanel guild={guild} channel={channel} myId={7} />);
    type('cats');
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Search' }))).toBe(false); // default prevented
    expect(fireEvent.mouseDown(screen.getByRole('textbox'))).toBe(true);
  });
});
