import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchPage = vi.fn();
vi.mock('../utils/desktop', () => ({ desktop: { fetchPage: (url) => fetchPage(url) } }));
vi.mock('../utils/android', () => ({ android: null }));
const prefs = { showLinkPreviews: true };
vi.mock('../utils/privacy', () => ({ getPrivacyPrefs: () => prefs }));

const { previewsFor } = await import('./linkPreviewService');

const page = (title) => ({ status: 200, url: 'https://x.test/', contentType: 'text/html', html: `<title>${title}</title>` });

beforeEach(() => {
  fetchPage.mockReset();
  prefs.showLinkPreviews = true;
});

describe('previewsFor', () => {
  it("fetches the message's links, not those the app draws itself", async () => {
    fetchPage.mockResolvedValue(page('A page'));
    const embeds = await previewsFor('see https://a.test/page and https://youtu.be/dQw4w9WgXcQ and https://b.test/clip.mp4');
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual(['https://a.test/page']);
    expect(embeds).toEqual([{ type: 'link', url: 'https://a.test/page', title: 'A page' }]);
  });

  it('remembers a link, and leaves out ones that fail', async () => {
    fetchPage.mockResolvedValueOnce(page('Once')).mockRejectedValueOnce(new Error('offline'));
    await previewsFor('https://c.test/');
    expect(await previewsFor('https://c.test/ https://d.test/')).toEqual([{ type: 'link', url: 'https://c.test/', title: 'Once' }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing with "Show link previews" off', async () => {
    prefs.showLinkPreviews = false;
    expect(await previewsFor('https://e.test/')).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
