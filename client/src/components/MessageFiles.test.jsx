// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageViewerProvider from './ImageViewerProvider';
import MessageFiles from './MessageFiles';

const files = [
  { id: '1', filename: 'tweet.png', url: 'https://s3.test/uploads/webhooks/1/tweet.png', content_type: 'image/png', size: 2048, width: 600, height: 400 },
  { id: '2', filename: 'second.png', url: 'https://s3.test/uploads/webhooks/2/second.png', content_type: 'image/png', size: 1024, width: 300, height: 200 },
];

function renderFiles() {
  return render(
    <ImageViewerProvider>
      <div data-image-gallery="">
        <MessageFiles attachments={files} />
      </div>
    </ImageViewerProvider>
  );
}

const shown = () => document.querySelector('.image-viewer-image')?.getAttribute('src');

beforeEach(() => {
  window.history.replaceState(null, '', '/channels/1/2');
});

describe('MessageFiles', () => {
  it("opens a bot's image in the image viewer, with the message's other images", () => {
    renderFiles();
    fireEvent.click(screen.getByAltText('second.png'));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('second.png');
    expect(shown()).toBe(files[1].url);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(shown()).toBe(files[0].url);
  });

  it('leaves a Ctrl or middle click to the browser (a new tab)', () => {
    renderFiles();
    const link = screen.getByAltText('tweet.png').closest('a');
    expect(link).toHaveAttribute('href', files[0].url);
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { button: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays a plain link without a viewer', () => {
    render(<MessageFiles attachments={[files[0]]} />);
    fireEvent.click(screen.getByAltText('tweet.png'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
