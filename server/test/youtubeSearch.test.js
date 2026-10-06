import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const youtubeSearch = require('../youtubeSearch.js');

// The shape of an InnerTube search answer (trimmed): videos sit deep inside section lists, next
// to shelves, channels and other things that aren't videos.
const video = (videoId, extra = {}) => ({
  videoRenderer: {
    videoId,
    title: { runs: [{ text: `Title of ${videoId}` }] },
    ownerText: { runs: [{ text: 'A channel' }] },
    lengthText: { simpleText: '1:02:03' },
    ...extra,
  },
});
const answer = (...items) => ({
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ channelRenderer: { channelId: 'UC1' } }, ...items] } },
    { continuationItemRenderer: {} },
  ] } } } },
});

describe('youtubeSearch', () => {
  beforeEach(() => youtubeSearch.cache.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reads clocks', () => {
    expect(youtubeSearch.secondsOf('1:02:03')).toBe(3723);
    expect(youtubeSearch.secondsOf('4:05')).toBe(245);
    expect(youtubeSearch.secondsOf('')).toBeNull();
    expect(youtubeSearch.secondsOf('LIVE')).toBeNull();
  });

  it('finds the videos, live streams without a length, and leaves out upcoming ones', () => {
    const results = youtubeSearch.parseResults(answer(
      video('aaaaaaaaaaa'),
      { shelfRenderer: { content: { verticalListRenderer: { items: [video('bbbbbbbbbbb', { lengthText: { simpleText: '0:59' } })] } } } },
      video('ccccccccccc', { lengthText: undefined, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] }),
      video('ddddddddddd', { upcomingEventData: { startTime: '1' } }),
      video('aaaaaaaaaaa'), // the same video again
      video('not-an-id'),
    ));
    expect(results).toEqual([
      { video_id: 'aaaaaaaaaaa', title: 'Title of aaaaaaaaaaa', author: 'A channel', duration: 3723, live: false },
      { video_id: 'bbbbbbbbbbb', title: 'Title of bbbbbbbbbbb', author: 'A channel', duration: 59, live: false },
      { video_id: 'ccccccccccc', title: 'Title of ccccccccccc', author: 'A channel', duration: null, live: true },
    ]);
  });

  it('asks YouTube once per query for a while', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => answer(video('aaaaaaaaaaa')) }));
    vi.stubGlobal('fetch', fetch);
    const first = await youtubeSearch.search('Cats ', { now: 1000 });
    expect(first).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ query: 'Cats', params: 'EgIQAQ==' });
    expect(await youtubeSearch.search('cats', { now: 2000 })).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    await youtubeSearch.search('cats', { now: 1000 + 11 * 60 * 1000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails with 502 when YouTube can't be asked", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(youtubeSearch.search('dogs')).rejects.toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(youtubeSearch.search('dogs')).rejects.toMatchObject({ status: 502 });
  });
});
