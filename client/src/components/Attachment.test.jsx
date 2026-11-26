// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderPlain, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(),
  getCachedAttachment: vi.fn(() => null),
  loadDecryptedPoster: vi.fn(),
  getCachedPoster: vi.fn(() => null),
}));

vi.mock('../services/videoStream', () => ({
  canStream: vi.fn(async () => false),
  streamUrl: vi.fn(() => '/__voicaw-media/stream-1'),
  isStreamUrl: vi.fn((url) => url.startsWith('/__voicaw-media/')),
  streamFailed: vi.fn(async () => true),
  releaseStream: vi.fn(),
}));

import Attachment from './Attachment';
import { setPrivacyPref } from '../utils/privacy';
import { applyPreferences } from '../utils/preferences';
import { ConfigContext, ReaderContext, NsfwChannelContext } from '../contexts';

// The app's config names its file store: only files there are attachments (else another site's).
const STORE = 'https://s3.test';
const render = (ui) => renderPlain(<ConfigContext.Provider value={{ s3Endpoint: STORE }}>{ui}</ConfigContext.Provider>);
import {
  loadDecryptedAttachment, getCachedAttachment, loadDecryptedPoster, getCachedPoster,
} from '../services/attachmentCache';
import { canStream, streamUrl, streamFailed } from '../services/videoStream';
import { buildAttachmentUrl } from '../services/attachmentCrypto';

const encryptedUrl = (type, size = 2048, dims = {}) =>
  buildAttachmentUrl('https://s3.test/uploads/abc.bin', { key: 'KEY', type, size, ...dims });
// A streamable (v2) video.
const videoUrl = (extra = {}) => encryptedUrl('video/mp4', 5_000_000, {
  width: 640, height: 360, nonce: 'NNNNNNNNNNNNNNNN', duration: 75, poster: 'poster-1.bin', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  getCachedAttachment.mockReturnValue(null);
  getCachedPoster.mockReturnValue(null);
  canStream.mockResolvedValue(false);
});

describe('Attachment', () => {
  it("waits for Show before loading a GIF when Settings → Privacy says not to show GIFs", () => {
    setPrivacyPref('gifs', false);
    try {
      const src = 'https://static.klipy.com/ii/a/hidden.webp#gif&w=498&h=374';
      const { container } = render(<Attachment src={src} alt="GIF" />);
      expect(screen.queryByRole('img')).toBeNull();
      expect(container.querySelector('.attachment-gif-hidden')).toHaveStyle({ width: '420px' });
      fireEvent.click(screen.getByRole('button', { name: 'Show GIF' }));
      expect(screen.getByRole('img', { name: 'GIF' })).toHaveAttribute('src', src);
    } finally {
      setPrivacyPref('gifs', true);
    }
  });

  it('shows a GIF from the picker in its final size, without telling the GIF site where', () => {
    const src = 'https://static.klipy.com/ii/a/b.webp#gif&w=498&h=374';
    render(<Attachment src={src} alt="GIF" />);
    const img = screen.getByRole('img', { name: 'GIF' });
    expect(img).toHaveAttribute('src', src);
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img.style.width).toBe('420px');
    expect(img.style.aspectRatio).toBe('498 / 374');
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it('renders legacy / external image URLs as a plain image without decrypting', () => {
    render(<Attachment src="https://media.voicaw.com/uploads/old.png" alt="old" />);

    expect(screen.getByRole('img', { name: 'old' })).toHaveAttribute('src', 'https://media.voicaw.com/uploads/old.png');
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it("treats an \"attachment\" on another site as that site's picture: not decrypted, held back by the privacy option", () => {
    const elsewhere = buildAttachmentUrl('https://tracker.example/uploads/abc.bin', { key: 'KEY', type: 'image/png', size: 10 });
    setPrivacyPref('linkPreviews', false);
    try {
      const { container } = render(<Attachment src={elsewhere} alt="cat.png" />);
      expect(screen.getByText('Picture from tracker.example')).toBeInTheDocument();
      expect(container.querySelector('img')).toBeNull();
      expect(loadDecryptedAttachment).not.toHaveBeenCalled();
    } finally {
      setPrivacyPref('linkPreviews', true);
    }
    // Before the config says where the store is, nothing is loaded.
    renderPlain(<Attachment src={encryptedUrl('image/png')} alt="early.png" />);
    expect(screen.getByText(/early\.png/)).toBeInTheDocument();
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it('decrypts and shows an encrypted image inline', async () => {
    loadDecryptedAttachment.mockResolvedValue('blob:decrypted-image');
    const url = encryptedUrl('image/png');

    render(<Attachment src={url} alt="cat.png" />);

    expect(screen.getByLabelText('Loading cat.png')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'cat.png' })).toHaveAttribute('src', 'blob:decrypted-image');
    expect(loadDecryptedAttachment).toHaveBeenCalledWith(url, expect.objectContaining({ key: 'KEY', type: 'image/png' }));
  });

  it("shows a big image's thumbnail, downloading nothing of the image itself", async () => {
    loadDecryptedPoster.mockResolvedValue('blob:thumbnail');
    const url = encryptedUrl('image/jpeg', 4_000_000, { width: 4000, height: 3000, poster: 'thumb-1.bin' });

    render(<Attachment src={url} alt="photo.jpg" />);

    expect(await screen.findByRole('img', { name: 'photo.jpg' })).toHaveAttribute('src', 'blob:thumbnail');
    expect(loadDecryptedPoster).toHaveBeenCalledWith(expect.objectContaining({ posterUrl: 'https://s3.test/uploads/thumb-1.bin' }));
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it("shows the image itself when its thumbnail can't be had, or it's already decrypted", async () => {
    loadDecryptedPoster.mockRejectedValue(new Error('gone'));
    loadDecryptedAttachment.mockResolvedValue('blob:whole');
    const url = encryptedUrl('image/jpeg', 4_000_000, { width: 4000, height: 3000, poster: 'thumb-1.bin' });
    const { unmount } = render(<Attachment src={url} alt="photo.jpg" />);
    expect(await screen.findByRole('img', { name: 'photo.jpg' })).toHaveAttribute('src', 'blob:whole');
    unmount();

    vi.clearAllMocks();
    getCachedAttachment.mockReturnValue('blob:sent');
    getCachedPoster.mockReturnValue('blob:thumbnail');
    render(<Attachment src={url} alt="photo.jpg" />);
    expect(screen.getByRole('img', { name: 'photo.jpg' })).toHaveAttribute('src', 'blob:sent');
    expect(loadDecryptedPoster).not.toHaveBeenCalled();
  });

  it('shows an already-decrypted attachment immediately, with no loading state', () => {
    getCachedAttachment.mockReturnValue('blob:cached-image');

    render(<Attachment src={encryptedUrl('image/png')} alt="sent.png" />);

    expect(screen.getByRole('img', { name: 'sent.png' })).toHaveAttribute('src', 'blob:cached-image');
    expect(screen.queryByLabelText('Loading sent.png')).not.toBeInTheDocument();
  });

  it('reserves the final size while loading when the dimensions are known', async () => {
    let finish;
    loadDecryptedAttachment.mockReturnValue(new Promise((r) => { finish = r; }));

    // 1600x900 scaled down to fit 420 wide.
    render(<Attachment src={encryptedUrl('image/jpeg', 10, { width: 1600, height: 900 })} alt="wide.jpg" />);

    const placeholder = screen.getByLabelText('Loading wide.jpg');
    expect(placeholder.style.width).toBe('420px');
    expect(placeholder.getAttribute('style')).toContain('aspect-ratio: 1600 / 900');

    await act(async () => finish('blob:wide'));
    const img = screen.getByRole('img', { name: 'wide.jpg' });
    expect(img.style.width).toBe('420px');
    expect(img.getAttribute('style')).toContain('aspect-ratio: 1600 / 900');
  });

  it('limits tall media by height when reserving space', () => {
    loadDecryptedAttachment.mockReturnValue(new Promise(() => {}));

    // 600x1200 scaled to 360 tall -> 180 wide.
    render(<Attachment src={encryptedUrl('image/png', 10, { width: 600, height: 1200 })} alt="tall.png" />);

    expect(screen.getByLabelText('Loading tall.png').style.width).toBe('180px');
  });

  it('shows a video as its poster, length and size, downloading nothing else until played', async () => {
    loadDecryptedPoster.mockResolvedValue('blob:poster');

    const { container } = render(<Attachment src={videoUrl()} alt="clip.mp4" />);

    await waitFor(() => expect(container.querySelector('.video-poster')).toHaveAttribute('src', 'blob:poster'));
    expect(loadDecryptedPoster).toHaveBeenCalledWith(expect.objectContaining({ posterUrl: 'https://s3.test/uploads/poster-1.bin' }));
    expect(container.querySelector('video')).toBeNull();
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
    expect(screen.getByText('1:15')).toBeInTheDocument();
    expect(screen.getByText('4.8 MB')).toBeInTheDocument();
    const player = container.querySelector('.video-player');
    expect(player.style.width).toBe('420px');
    expect(player.style.aspectRatio).toBe('640 / 360');
  });

  it('streams a video through the service worker when it can', async () => {
    loadDecryptedPoster.mockResolvedValue('blob:poster');
    canStream.mockResolvedValue(true);

    const { container } = render(<Attachment src={videoUrl()} alt="clip.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' }));

    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/__voicaw-media/stream-1'));
    expect(streamUrl).toHaveBeenCalledWith(expect.objectContaining({ nonce: 'NNNNNNNNNNNNNNNN', size: 5_000_000 }));
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
  });

  it('downloads the whole video when played if it cannot stream (an older video, no service worker)', async () => {
    loadDecryptedAttachment.mockResolvedValue('blob:decrypted-video');

    const { container } = render(<Attachment src={encryptedUrl('video/mp4')} alt="clip.mp4" />);
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
    expect(container.querySelector('.video-placeholder')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' }));

    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', 'blob:decrypted-video'));
    expect(loadDecryptedAttachment).toHaveBeenCalledTimes(1);
  });

  it('falls back to the whole file when streaming fails, and says so when the browser cannot play it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadDecryptedPoster.mockResolvedValue('blob:poster');
    canStream.mockResolvedValue(true);
    loadDecryptedAttachment.mockResolvedValue('blob:whole');

    const { container } = render(<Attachment src={videoUrl()} alt="clip.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' }));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/__voicaw-media/stream-1'));

    fireEvent.error(container.querySelector('video'));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', 'blob:whole'));
    expect(streamFailed).toHaveBeenCalledWith('/__voicaw-media/stream-1');

    fireEvent.error(container.querySelector('video'));
    expect(await screen.findByText("This video can't play in this browser.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download clip.mp4' })).toBeInTheDocument();
  });

  it('downloads a video to save it, with the decrypted file', async () => {
    loadDecryptedPoster.mockResolvedValue('blob:poster');
    loadDecryptedAttachment.mockResolvedValue('blob:whole');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<Attachment src={videoUrl()} alt="clip.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download clip.mp4' }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(loadDecryptedAttachment).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('shows other files as a download box and only fetches when downloading', async () => {
    loadDecryptedAttachment.mockResolvedValue('blob:decrypted-file');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<Attachment src={encryptedUrl('application/pdf', 1536)} alt="report.pdf" />);

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(loadDecryptedAttachment).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('falls back to a download box when an image fails to decrypt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadDecryptedAttachment.mockRejectedValue(new Error('bad key'));

    render(<Attachment src={encryptedUrl('image/png')} alt="broken.png" />);

    expect(await screen.findByText('Download failed')).toBeInTheDocument();
    expect(screen.getByText('broken.png')).toBeInTheDocument();
  });

  it('shows a pending message attachment from its local preview', () => {
    const localAttachments = { 3: { previewUrl: 'blob:local', type: 'image/jpeg', size: 10 } };

    render(<Attachment src="attachment:3" alt="me.jpg" localAttachments={localAttachments} />);

    expect(screen.getByRole('img', { name: 'me.jpg' })).toHaveAttribute('src', 'blob:local');
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it('blurs a spoiler image until clicked, keeping it out of the image viewer until then', async () => {
    getCachedAttachment.mockReturnValue('blob:twist');

    const { container } = render(<Attachment src={encryptedUrl('image/png', 10, { spoiler: true })} alt="twist.png" />);

    expect(screen.queryByRole('img', { name: 'twist.png' })).not.toBeInTheDocument();
    expect(container.querySelector('.attachment-spoiler img')).toHaveAttribute('src', 'blob:twist');
    expect(container.querySelector('[data-gallery-item]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Spoiler: twist.png, select to reveal' }));

    expect(screen.getByRole('img', { name: 'twist.png' })).toHaveAttribute('src', 'blob:twist');
    expect(container.querySelector('.attachment-spoiler')).toBeNull();
  });

  it('covers a spoiler video (its poster blurred) until clicked', () => {
    getCachedPoster.mockReturnValue('blob:poster');

    const { container } = render(<Attachment src={videoUrl({ spoiler: true })} alt="clip.mp4" />);

    expect(container.querySelector('.attachment-spoiler img')).toHaveAttribute('src', 'blob:poster');
    expect(screen.queryByRole('button', { name: 'Play clip.mp4' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Spoiler: clip.mp4, select to reveal' }));
    expect(screen.getByRole('button', { name: 'Play clip.mp4' })).toBeInTheDocument();
    expect(container.querySelector('.attachment-spoiler')).toBeNull();
  });

  it("covers a pending message's spoiler too", () => {
    const localAttachments = { 3: { previewUrl: 'blob:local', type: 'image/jpeg', size: 10, spoiler: true } };

    render(<Attachment src="attachment:3" alt="me.jpg" localAttachments={localAttachments} />);

    expect(screen.getByRole('button', { name: 'Spoiler: me.jpg, select to reveal' })).toBeInTheDocument();
  });

  describe('in an NSFW channel', () => {
    const inNsfw = (ui) => <NsfwChannelContext.Provider value>{ui}</NsfwChannelContext.Provider>;
    afterEach(() => applyPreferences({ blurNsfw: true }));

    it('covers an image with "NSFW" until clicked, out of the image viewer until then', () => {
      getCachedAttachment.mockReturnValue('blob:art');
      const { container } = render(inNsfw(<Attachment src={encryptedUrl('image/png', 10)} alt="art.png" />));

      expect(screen.queryByRole('img', { name: 'art.png' })).not.toBeInTheDocument();
      expect(container.querySelector('[data-gallery-item]')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'NSFW: art.png, select to reveal' }));
      expect(screen.getByRole('img', { name: 'art.png' })).toHaveAttribute('src', 'blob:art');
    });

    it('gives a spoiler just the one cover, labelled Spoiler', () => {
      getCachedAttachment.mockReturnValue('blob:twist');
      const { container } = render(inNsfw(<Attachment src={encryptedUrl('image/png', 10, { spoiler: true })} alt="twist.png" />));

      expect(container.querySelectorAll('.attachment-spoiler')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Spoiler: twist.png, select to reveal' }));
      expect(screen.getByRole('img', { name: 'twist.png' })).toBeInTheDocument();
      expect(container.querySelector('.attachment-spoiler')).toBeNull();
    });

    it('covers GIFs, other sites\' images and videos too', () => {
      const { container } = render(inNsfw(
        <>
          <Attachment src="https://static.klipy.com/ii/a/b.webp#gif&w=498&h=374" alt="GIF" />
          <Attachment src="https://example.com/pic.png" alt="pic" />
          <Attachment src={videoUrl()} alt="clip.mp4" />
        </>
      ));
      expect(container.querySelectorAll('.attachment-spoiler')).toHaveLength(3);
      expect(screen.queryByRole('button', { name: 'Play clip.mp4' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'NSFW: clip.mp4, select to reveal' }));
      expect(screen.getByRole('button', { name: 'Play clip.mp4' })).toBeInTheDocument();
    });

    it('shows media straight away with Settings → Content\'s blur off, but not spoilers', () => {
      applyPreferences({ blurNsfw: false });
      getCachedAttachment.mockReturnValue('blob:x');
      render(inNsfw(
        <>
          <Attachment src={encryptedUrl('image/png', 10)} alt="art.png" />
          <Attachment src={encryptedUrl('image/png', 10, { spoiler: true })} alt="twist.png" />
        </>
      ));
      expect(screen.getByRole('img', { name: 'art.png' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Spoiler: twist.png, select to reveal' })).toBeInTheDocument();
    });
  });

  describe('books', () => {
    const withReader = (ui, openReader = vi.fn()) => (
      <ReaderContext.Provider value={{ openReader }}>{ui}</ReaderContext.Provider>
    );

    it("shows a book's cover, loaded from its thumbnail, with Read and Download", async () => {
      loadDecryptedPoster.mockResolvedValue('blob:cover');
      const openReader = vi.fn();
      render(withReader(<Attachment src={encryptedUrl('application/epub+zip', 300_000, { width: 280, height: 400, poster: 'cover-1.bin' })} alt="novel.epub" />, openReader));
      const cover = await screen.findByRole('img', { name: 'Cover of novel.epub' });
      expect(cover).toHaveAttribute('src', 'blob:cover');
      expect(cover.style.aspectRatio).toBe('280 / 400');
      expect(screen.getByRole('button', { name: 'Download novel.epub' })).toBeInTheDocument();
      expect(loadDecryptedAttachment).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Read novel.epub' }));
      expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ name: 'novel.epub', positionKey: 'abc.bin' }));
      // The book itself downloads only when the reader asks for it.
      expect(loadDecryptedAttachment).not.toHaveBeenCalled();
      loadDecryptedAttachment.mockResolvedValue('blob:book');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, blob: async () => new Blob(['zip']) });
      const progress = vi.fn();
      await expect(openReader.mock.calls[0][0].load(progress)).resolves.toBeInstanceOf(Blob);
      expect(loadDecryptedAttachment).toHaveBeenCalledWith(expect.any(String), expect.anything(), progress);
      expect(fetchSpy).toHaveBeenCalledWith('blob:book');
      fetchSpy.mockRestore();
    });

    it('shows a book without a cover (an older app sent it) as a book, by type or by name', () => {
      render(withReader(
        <>
          <Attachment src={encryptedUrl('application/epub+zip')} alt="a.epub" />
          <Attachment src={encryptedUrl('application/octet-stream')} alt="old.EPUB" />
        </>
      ));
      expect(screen.getByRole('button', { name: 'Read a.epub' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Read old.EPUB' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /Cover/ })).toBeNull();
      expect(loadDecryptedPoster).not.toHaveBeenCalled();
    });

    it('gives other files no Read button, and books none where there is no reader', () => {
      render(
        <>
          {withReader(<Attachment src={encryptedUrl('application/zip')} alt="report.zip" />)}
          <Attachment src={encryptedUrl('application/epub+zip')} alt="b.epub" />
        </>
      );
      expect(screen.queryByRole('button', { name: /^Read/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Download b.epub' })).toBeInTheDocument();
    });

    it("covers a spoiler book's cover until clicked", async () => {
      loadDecryptedPoster.mockResolvedValue('blob:cover');
      render(withReader(<Attachment src={encryptedUrl('application/epub+zip', 10, { width: 2, height: 3, poster: 'c.bin', spoiler: true })} alt="twist.epub" />));
      fireEvent.click(await screen.findByRole('button', { name: 'Spoiler: twist.epub, select to reveal' }));
      expect(screen.getByRole('img', { name: 'Cover of twist.epub' })).toBeInTheDocument();
    });

    it("shows a pending book from the local file, with the cover read when it was attached", () => {
      const openReader = vi.fn();
      render(withReader(
        <Attachment src="attachment:3" alt="new.epub" localAttachments={{ 3: { previewUrl: 'blob:local', coverUrl: 'blob:local-cover', type: 'application/epub+zip', size: 10, width: 2, height: 3 } }} />,
        openReader,
      ));
      expect(screen.getByRole('img', { name: 'Cover of new.epub' })).toHaveAttribute('src', 'blob:local-cover');
      fireEvent.click(screen.getByRole('button', { name: 'Read new.epub' }));
      expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ name: 'new.epub', positionKey: null }));
    });
  });

  describe('PDFs', () => {
    const withReader = (ui, openReader = vi.fn()) => (
      <ReaderContext.Provider value={{ openReader }}>{ui}</ReaderContext.Provider>
    );
    const pdfUrl = (extra = {}) => encryptedUrl('application/pdf', 3_400_000, {
      width: 280, height: 396, poster: 'page-1.bin', nonce: 'NNNNNNNNNNNNNNNN', pages: 12, ...extra,
    });

    it('shows its first page and number of pages, with Open and Download', async () => {
      loadDecryptedPoster.mockResolvedValue('blob:page');
      const openReader = vi.fn();
      render(withReader(<Attachment src={pdfUrl()} alt="report.pdf" />, openReader));
      const preview = await screen.findByRole('img', { name: 'First page of report.pdf' });
      expect(preview).toHaveAttribute('src', 'blob:page');
      expect(preview.style.aspectRatio).toBe('280 / 396');
      expect(screen.getByText('12 pages · 3.2 MB')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeInTheDocument();
      expect(loadDecryptedAttachment).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }));
      expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pdf', name: 'report.pdf', positionKey: 'abc.bin' }));
      expect(loadDecryptedAttachment).not.toHaveBeenCalled();
    });

    it('says "1 page", and only the size when the count is unknown', () => {
      render(withReader(
        <>
          <Attachment src={pdfUrl({ pages: 1, poster: undefined, width: undefined, height: undefined })} alt="one.pdf" />
          <Attachment src={encryptedUrl('application/pdf', 2048)} alt="old.pdf" />
        </>
      ));
      expect(screen.getByText(/^1 page · /)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open old.pdf' })).toBeInTheDocument();
      expect(screen.getAllByText(/pages? ·/)).toHaveLength(1);
      expect(screen.queryByRole('img', { name: /First page/ })).toBeNull();
    });

    it('treats a .pdf with no type as a PDF', () => {
      render(withReader(<Attachment src={encryptedUrl('application/octet-stream')} alt="Scan.PDF" />));
      expect(screen.getByRole('button', { name: 'Open Scan.PDF' })).toBeInTheDocument();
    });

    it("covers a spoiler PDF's first page until clicked", async () => {
      loadDecryptedPoster.mockResolvedValue('blob:page');
      render(withReader(<Attachment src={pdfUrl({ spoiler: true })} alt="twist.pdf" />));
      fireEvent.click(await screen.findByRole('button', { name: 'Spoiler: twist.pdf, select to reveal' }));
      expect(screen.getByRole('img', { name: 'First page of twist.pdf' })).toBeInTheDocument();
    });

    it('shows a pending PDF from the local file', () => {
      const openReader = vi.fn();
      render(withReader(
        <Attachment src="attachment:4" alt="new.pdf" localAttachments={{ 4: { previewUrl: 'blob:local', coverUrl: 'blob:local-page', type: 'application/pdf', size: 2048, width: 2, height: 3, pages: 3 } }} />,
        openReader,
      ));
      expect(screen.getByRole('img', { name: 'First page of new.pdf' })).toHaveAttribute('src', 'blob:local-page');
      expect(screen.getByText(/^3 pages · /)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open new.pdf' }));
      expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pdf', name: 'new.pdf', positionKey: null }));
    });
  });

  it('shows a placeholder label when a draft placeholder has no local file', () => {
    render(<Attachment src="attachment:7" alt="gone.png" />);

    expect(screen.getByText('📎 gone.png')).toBeInTheDocument();
  });
});
