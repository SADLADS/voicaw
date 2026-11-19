import './helpers/mockS3.js';
import { describe, it, expect, afterEach, vi } from 'vitest';

const { gifPagePreview, isGifPage } = require('../gifLinks.js');
const { setSetting } = require('../appSettings');

const KLIPY_ITEM = {
  id: 1405,
  slug: 'happy-birthday-1405',
  type: 'gif',
  title: 'Happy Birthday',
  file: {
    hd: { webp: { url: 'https://static.klipy.com/ii/abc/hd.webp', width: 498, height: 374 } },
    sm: { webp: { url: 'https://static.klipy.com/ii/abc/sm.webp', width: 200, height: 150 } },
  },
};

const noPage = async () => {
  throw new Error('should not fetch the page');
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await setSetting('klipyApiKey', '');
});

describe('GIF site links as link previews', () => {
  it('knows which links are GIF pages', () => {
    expect(isGifPage('https://klipy.com/gifs/happy-birthday-1405')).toBe(true);
    expect(isGifPage('https://tenor.com/view/happy-birthday-gif-25393212')).toBe(true);
    expect(isGifPage('https://tenor.com/en-GB/view/cat-gif-1')).toBe(true);
    expect(isGifPage('https://klipy.com/')).toBe(false);
    expect(isGifPage('https://example.com/gifs/x')).toBe(false);
  });

  it("looks a Klipy GIF up by its slug with the picker's key, and makes it a gifv embed", async () => {
    await setSetting('klipyApiKey', 'test-key');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: true, data: { data: [KLIPY_ITEM] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const link = 'https://klipy.com/gifs/happy-birthday-1405';
    expect(await gifPagePreview(link, noPage)).toEqual({
      type: 'gifv',
      url: link,
      provider: { name: 'KLIPY', url: 'https://klipy.com' },
      thumbnail: { url: 'https://static.klipy.com/ii/abc/hd.webp', width: 498, height: 374 },
    });
    const asked = new URL(fetchMock.mock.calls[0][0]);
    expect(asked.pathname).toBe('/api/v1/test-key/gifs/items');
    expect(asked.searchParams.get('slugs')).toBe('happy-birthday-1405');
  });

  it('gives no Klipy preview without a key, or when Klipy has nothing or fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const link = 'https://klipy.com/gifs/happy-birthday-1405';
    expect(await gifPagePreview(link, noPage)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await setSetting('klipyApiKey', 'test-key');
    expect(await gifPagePreview(link, noPage)).toBeNull();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: { data: [{ ...KLIPY_ITEM, file: { hd: { webp: { url: 'https://evil.example/x.webp' } } } }] } }) }));
    expect(await gifPagePreview(link, noPage)).toBeNull();
  });

  it("uses a Tenor page's own GIF and MP4, only from Tenor's media hosts", async () => {
    const link = 'https://tenor.com/view/happy-birthday-gif-25393212';
    const page = {
      type: 'video', url: link, title: 'Happy Birthday GIF',
      image: { url: 'https://media1.tenor.com/m/abc/happy.gif', width: 281, height: 498 },
      video: { url: 'https://media.tenor.com/abc/happy.mp4', width: 281, height: 498 },
    };
    expect(await gifPagePreview(link, async () => page)).toEqual({
      type: 'gifv',
      url: link,
      provider: { name: 'Tenor', url: 'https://tenor.com' },
      thumbnail: { url: 'https://media1.tenor.com/m/abc/happy.gif', width: 281, height: 498 },
      video: { url: 'https://media.tenor.com/abc/happy.mp4', width: 281, height: 498 },
    });
    expect(await gifPagePreview(link, async () => ({ ...page, image: { url: 'https://elsewhere.example/a.gif' } }))).toBeNull();
    expect(await gifPagePreview(link, async () => null)).toBeNull();
  });

  it('leaves other links to the usual preview', async () => {
    expect(await gifPagePreview('https://example.com/page', noPage)).toBeUndefined();
  });
});
