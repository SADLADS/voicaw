// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(),
  getCachedAttachment: vi.fn(() => null),
}));

import Attachment from './Attachment';
import { loadDecryptedAttachment, getCachedAttachment } from '../services/attachmentCache';
import { buildAttachmentUrl } from '../services/attachmentCrypto';

const encryptedUrl = (type, size = 2048, dims = {}) =>
  buildAttachmentUrl('https://s3.test/uploads/abc.bin', { key: 'KEY', type, size, ...dims });

beforeEach(() => {
  vi.clearAllMocks();
  getCachedAttachment.mockReturnValue(null);
});

describe('Attachment', () => {
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

  it('decrypts and shows an encrypted image inline', async () => {
    loadDecryptedAttachment.mockResolvedValue('blob:decrypted-image');
    const url = encryptedUrl('image/png');

    render(<Attachment src={url} alt="cat.png" />);

    expect(screen.getByLabelText('Loading cat.png')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'cat.png' })).toHaveAttribute('src', 'blob:decrypted-image');
    expect(loadDecryptedAttachment).toHaveBeenCalledWith(url, expect.objectContaining({ key: 'KEY', type: 'image/png' }));
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
    render(<Attachment src={encryptedUrl('video/mp4', 10, { width: 600, height: 1200 })} alt="tall.mp4" />);

    expect(screen.getByLabelText('Loading tall.mp4').style.width).toBe('180px');
  });

  it('shows an encrypted video inline with controls', async () => {
    loadDecryptedAttachment.mockResolvedValue('blob:decrypted-video');

    const { container } = render(<Attachment src={encryptedUrl('video/mp4')} alt="clip.mp4" />);

    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', 'blob:decrypted-video'));
    expect(container.querySelector('video')).toHaveAttribute('controls');
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

  it('covers a spoiler video (without controls) until clicked', () => {
    getCachedAttachment.mockReturnValue('blob:clip');

    const { container } = render(<Attachment src={encryptedUrl('video/mp4', 10, { spoiler: true })} alt="clip.mp4" />);

    expect(container.querySelector('.attachment-spoiler video')).not.toHaveAttribute('controls');
    fireEvent.click(screen.getByRole('button', { name: 'Spoiler: clip.mp4, select to reveal' }));
    expect(container.querySelector('video')).toHaveAttribute('controls');
  });

  it("covers a pending message's spoiler too", () => {
    const localAttachments = { 3: { previewUrl: 'blob:local', type: 'image/jpeg', size: 10, spoiler: true } };

    render(<Attachment src="attachment:3" alt="me.jpg" localAttachments={localAttachments} />);

    expect(screen.getByRole('button', { name: 'Spoiler: me.jpg, select to reveal' })).toBeInTheDocument();
  });

  it('shows a placeholder label when a draft placeholder has no local file', () => {
    render(<Attachment src="attachment:7" alt="gone.png" />);

    expect(screen.getByText('📎 gone.png')).toBeInTheDocument();
  });
});
