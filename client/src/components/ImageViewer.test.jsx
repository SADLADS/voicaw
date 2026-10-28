// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(() => new Promise(() => {})),
  getCachedAttachment: vi.fn(() => null),
}));
vi.mock('../utils/saveFile', () => ({
  triggerDownload: vi.fn(),
  saveUrlAs: vi.fn(),
  openInNewTab: vi.fn(),
}));

import ImageViewerProvider from './ImageViewerProvider';
import Attachment from './Attachment';
import { getCachedAttachment, loadDecryptedAttachment } from '../services/attachmentCache';
import { saveUrlAs, openInNewTab } from '../utils/saveFile';
import { buildAttachmentUrl } from '../services/attachmentCrypto';

const imageUrl = (file, size = 2048) => buildAttachmentUrl(`https://s3.test/uploads/${file}.bin`, {
  key: 'KEY', type: 'image/png', size, width: 1600, height: 900,
});
const url = imageUrl('abc');

function renderImage(onComposerEscape = () => {}) {
  getCachedAttachment.mockReturnValue('blob:cat');
  // Stands in for the composer's own window-level Escape listener.
  window.addEventListener('keydown', onComposerEscape);
  return render(
    <ImageViewerProvider>
      <Attachment src={url} alt="cat.png" />
    </ImageViewerProvider>
  );
}

// Three images in one message (as MessageList marks it), then one in another message.
function renderMessages() {
  const decrypted = { [imageUrl('one')]: 'blob:one', [imageUrl('two', 4096)]: 'blob:two', [imageUrl('other')]: 'blob:other' };
  getCachedAttachment.mockImplementation((u) => decrypted[u] ?? null);
  return render(
    <ImageViewerProvider>
      <div data-image-gallery="">
        <p>
          <Attachment src={imageUrl('one')} alt="one.png" />
          <Attachment src={imageUrl('two', 4096)} alt="two.png" />
          <Attachment src={imageUrl('three')} alt="three.png" />
        </p>
      </div>
      <div data-image-gallery="">
        <Attachment src={imageUrl('other')} alt="other.png" />
      </div>
    </ImageViewerProvider>
  );
}

const shown = () => document.querySelector('.image-viewer-image')?.getAttribute('src');

beforeEach(() => {
  vi.clearAllMocks();
  getCachedAttachment.mockReset();
  loadDecryptedAttachment.mockImplementation(() => new Promise(() => {}));
  window.history.replaceState(null, '', '/dm/2');
});

describe('ImageViewer', () => {
  it('opens a clicked image full screen, with its name and size', () => {
    renderImage();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));

    const dialog = screen.getByRole('dialog', { name: 'cat.png' });
    expect(dialog).toHaveTextContent('cat.png');
    expect(dialog).toHaveTextContent('2.0 KB');
    expect(dialog.querySelector('.image-viewer-image')).toHaveAttribute('src', 'blob:cat');
  });

  it('saves and opens the decrypted image', async () => {
    renderImage();
    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveUrlAs).toHaveBeenCalledWith('blob:cat', 'cat.png');

    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
    await waitFor(() => expect(openInNewTab).toHaveBeenCalledWith('blob:cat', 'cat.png'));
  });

  it("right-clicking the image opens its menu (no link: it's encrypted); Escape closes only the menu", async () => {
    renderImage();
    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));
    fireEvent.contextMenu(document.querySelector('.image-viewer-image'), { clientX: 50, clientY: 60 });
    const menu = screen.getByRole('menu', { name: 'cat.png' });
    expect(menu.closest('.context-menu-root')).toHaveClass('over-viewer');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.firstChild.firstChild.textContent))
      .toEqual(['Copy Image', 'Save Image', 'Open Image']);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('.image-viewer-image'), { clientX: 50, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Image' }));
    await waitFor(() => expect(saveUrlAs).toHaveBeenCalledWith('blob:cat', 'cat.png'));
  });

  it('closes on Escape without the composer also seeing it', async () => {
    const composerEscape = vi.fn();
    renderImage(composerEscape);
    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(composerEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', composerEscape);
  });

  it('closes with the back button, staying on the same page', async () => {
    renderImage();

    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));
    expect(window.history.state?.voicawImageViewer).toBe(true);

    window.history.back();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/dm/2');
  });

  it('removes its history entry when closed from the viewer', async () => {
    renderImage();
    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.history.state?.voicawImageViewer).toBeFalsy();
  });

  it('shows no thumbnails or arrows for a single image', () => {
    renderMessages();
    fireEvent.click(screen.getByRole('button', { name: 'other.png' }));

    expect(screen.queryByRole('group', { name: 'Images in this message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
  });

  it("steps through the message's images with the arrows, keys and thumbnails", () => {
    renderMessages();
    fireEvent.click(screen.getByRole('button', { name: 'two.png' }));

    const dialog = screen.getByRole('dialog');
    expect(shown()).toBe('blob:two');
    expect(dialog).toHaveTextContent('2 / 3');
    expect(dialog).toHaveTextContent('4.0 KB');
    // Only this message's images.
    const thumbnails = within(screen.getByRole('group', { name: 'Images in this message' })).getAllByRole('button');
    expect(thumbnails.map((t) => t.getAttribute('aria-label'))).toEqual(['Image 1: one.png', 'Image 2: two.png', 'Image 3: three.png']);
    expect(thumbnails[1]).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(shown()).toBe('blob:one');
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(shown()).toBe('blob:two');

    fireEvent.click(thumbnails[0]);
    expect(shown()).toBe('blob:one');
    expect(screen.getByRole('dialog')).toHaveTextContent('1 / 3');
  });

  it('includes images still decrypting, and shows them once ready', async () => {
    // Like the real cache: one shared decryption per attachment.
    let finish;
    const three = new Promise((r) => { finish = r; });
    loadDecryptedAttachment.mockImplementation((u) => (u === imageUrl('three') ? three : new Promise(() => {})));
    renderMessages();
    fireEvent.click(screen.getByRole('button', { name: 'one.png' }));

    fireEvent.click(screen.getByRole('button', { name: 'Image 3: three.png' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Decrypting…');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();

    await act(async () => finish('blob:three'));
    expect(shown()).toBe('blob:three');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveUrlAs).toHaveBeenCalledWith('blob:three', 'three.png');
  });
});
