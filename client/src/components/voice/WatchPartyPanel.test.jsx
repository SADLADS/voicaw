// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ party: null, prefs: { youtubeEmbeds: true } }));
const calls = vi.hoisted(() => ({ addVideo: vi.fn(), searchVideos: vi.fn(), addMedia: vi.fn(), searchMedia: vi.fn(), mediaEpisodes: vi.fn() }));
vi.mock('../../voice/watchParty', async (importOriginal) => ({
  ...(await importOriginal()),
  useWatchParty: () => state.party,
  useWatchPartyLog: () => [],
  addVideo: calls.addVideo,
  searchVideos: calls.searchVideos,
  addMedia: calls.addMedia,
  searchMedia: calls.searchMedia,
  mediaEpisodes: calls.mediaEpisodes,
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

describe('WatchPartyPanel with a media server', () => {
  const withServer = { id: 1, media_server: { kind: 'jellyfin', name: 'Home Media', url: 'https://media.example.com' } };
  const library = [
    { media_id: 'film1', type: 'Movie', title: 'A Film', series: null, season: null, episode: null, year: 2020, duration: 5400, image_url: 'https://media.example.com/Items/film1/Images/Primary' },
    { media_id: 'show1', type: 'Series', title: 'A Show', series: null, season: null, episode: null, year: 2019, duration: null, image_url: null },
  ];
  const episodes = [
    { media_id: 'ep1', type: 'Episode', title: 'Pilot', series: 'A Show', season: 1, episode: 1, year: null, duration: 1800, image_url: null },
  ];
  const box = () => screen.getByRole('textbox');

  beforeEach(() => {
    state.party = null;
    calls.addVideo.mockReset().mockResolvedValue(null);
    calls.searchVideos.mockReset().mockResolvedValue(found);
    calls.addMedia.mockReset().mockResolvedValue(null);
    calls.searchMedia.mockReset().mockResolvedValue(library);
    calls.mediaEpisodes.mockReset().mockResolvedValue(episodes);
  });

  it('searches the media server first, YouTube when switched to', async () => {
    render(<WatchPartyPanel guild={withServer} channel={channel} myId={7} />);
    expect(box().placeholder).toBe('Search Home Media or paste a link');
    expect(screen.getByRole('button', { name: 'Home Media' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(box(), { target: { value: 'film' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(calls.searchMedia).toHaveBeenCalledWith(1, 2, 'film');
    expect(await screen.findByText('A Film')).toBeTruthy();
    expect(screen.getByText('2020 · 1:30:00')).toBeTruthy();
    expect(document.querySelector('.watch-party-result-thumb.poster').getAttribute('src')).toBe('https://media.example.com/Items/film1/Images/Primary');

    fireEvent.click(screen.getByRole('button', { name: 'Play A Film' }));
    await waitFor(() => expect(calls.addMedia).toHaveBeenCalledWith(1, 2, 'film1'));

    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
    expect(box().placeholder).toBe('Search YouTube or paste a link');
    fireEvent.change(box(), { target: { value: 'cats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(calls.searchVideos).toHaveBeenCalledWith(1, 2, 'cats');
    expect(await screen.findByText('Cats at play')).toBeTruthy();
  });

  it("opens a show to its episodes, and back", async () => {
    render(<WatchPartyPanel guild={withServer} channel={channel} myId={7} />);
    fireEvent.change(box(), { target: { value: 'show' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Episodes of A Show' }));
    expect(calls.mediaEpisodes).toHaveBeenCalledWith(1, 2, 'show1');
    expect(await screen.findByText('Pilot')).toBeTruthy();
    expect(screen.getByText('S1 E1 · 30:00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play Pilot' }));
    await waitFor(() => expect(calls.addMedia).toHaveBeenCalledWith(1, 2, 'ep1'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the results' }));
    expect(screen.getByText('A Film')).toBeTruthy();
  });

  it("adds links to the server's web app and YouTube's alike", async () => {
    render(<WatchPartyPanel guild={withServer} channel={channel} myId={7} />);
    fireEvent.change(box(), { target: { value: 'https://media.example.com/web/#/details?id=film1&serverId=x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls.addMedia).toHaveBeenCalledWith(1, 2, 'film1'));
    fireEvent.change(box(), { target: { value: 'https://youtu.be/ccccccccccc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls.addVideo).toHaveBeenCalledWith(1, 2, 'ccccccccccc'));
    fireEvent.change(box(), { target: { value: 'https://elsewhere.example.com/web/#/details?id=x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('alert').textContent).toBe("That isn't a link to a YouTube video or to something on Home Media.");
  });

  it('describes its videos in the queue', () => {
    state.party = {
      current: { id: 1, source: 'media', media_id: 'ep1', media: episodes[0], title: 'Pilot', duration: 1800, added_by: 7 },
      queue: [{ id: 2, source: 'media', media_id: 'film1', media: library[0], title: 'A Film', duration: 5400, added_by: 7 }],
      playing: true,
    };
    render(<WatchPartyPanel guild={withServer} channel={channel} myId={7} />);
    expect(screen.getByText('A Show · S1 E1 · 30:00 · added by alice')).toBeTruthy();
    expect(screen.getByText('2020 · 1:30:00 · added by alice')).toBeTruthy();
  });
});
