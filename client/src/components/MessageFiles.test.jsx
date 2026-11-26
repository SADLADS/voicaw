// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageViewerProvider from './ImageViewerProvider';
import MessageFiles from './MessageFiles';
import { ConfigContext, ReaderContext } from '../contexts';

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

  it("lets a bot's book in our store be read, but not one on another site", () => {
    const openReader = vi.fn();
    render(
      <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
        <ReaderContext.Provider value={{ openReader }}>
          <MessageFiles attachments={[
            { id: '3', filename: 'story.epub', url: 'https://s3.test/uploads/webhooks/3/story.epub', content_type: 'application/epub+zip', size: 10 },
            { id: '4', filename: 'elsewhere.epub', url: 'https://cdn.example/elsewhere.epub', content_type: 'application/epub+zip', size: 10 },
          ]}
          />
        </ReaderContext.Provider>
      </ConfigContext.Provider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read story.epub' }));
    expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ name: 'story.epub', positionKey: 'story.epub' }));
    expect(screen.queryByRole('button', { name: 'Read elsewhere.epub' })).toBeNull();
  });

  it("lets a bot's PDF in our store be opened, but not one on another site", () => {
    const openReader = vi.fn();
    render(
      <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test' }}>
        <ReaderContext.Provider value={{ openReader }}>
          <MessageFiles attachments={[
            { id: '5', filename: 'report.pdf', url: 'https://s3.test/uploads/webhooks/5/report.pdf', content_type: 'application/pdf', size: 10 },
            { id: '6', filename: 'elsewhere.pdf', url: 'https://cdn.example/elsewhere.pdf', content_type: 'application/pdf', size: 10 },
          ]}
          />
        </ReaderContext.Provider>
      </ConfigContext.Provider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }));
    expect(openReader).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pdf', name: 'report.pdf', positionKey: 'report.pdf' }));
    expect(screen.queryByRole('button', { name: 'Open elsewhere.pdf' })).toBeNull();
  });
});
