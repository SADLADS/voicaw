// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(),
  getCachedAttachment: vi.fn(() => null),
}));
vi.mock('../utils/saveFile', () => ({
  triggerDownload: vi.fn(),
  saveUrlAs: vi.fn(),
  openInNewTab: vi.fn(),
}));

import ImageViewerProvider from './ImageViewerProvider';
import Attachment from './Attachment';
import { getCachedAttachment } from '../services/attachmentCache';
import { saveUrlAs, openInNewTab } from '../utils/saveFile';
import { buildAttachmentUrl } from '../services/attachmentCrypto';

const url = buildAttachmentUrl('https://s3.test/uploads/abc.bin', {
  key: 'KEY', type: 'image/png', size: 2048, width: 1600, height: 900,
});

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

beforeEach(() => {
  vi.clearAllMocks();
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

  it('saves and opens the decrypted image', () => {
    renderImage();
    fireEvent.click(screen.getByRole('button', { name: 'cat.png' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveUrlAs).toHaveBeenCalledWith('blob:cat', 'cat.png');

    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
    expect(openInNewTab).toHaveBeenCalledWith('blob:cat');
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
});
