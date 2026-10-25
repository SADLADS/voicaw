// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AttachmentTray from './AttachmentTray';
import { ImageViewerContext } from '../contexts';

const draft = (id, type, extra = {}) => ({ id, name: `f${id}`, type, size: 1, previewUrl: `blob:${id}`, ...extra });

describe('AttachmentTray', () => {
  it('offers the spoiler toggle for images and videos only', () => {
    const onToggleSpoiler = vi.fn();
    render(
      <AttachmentTray
        drafts={[draft(1, 'image/png'), draft(2, 'video/mp4'), draft(3, 'application/pdf')]}
        onRemove={() => {}}
        onToggleSpoiler={onToggleSpoiler}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark f1 as spoiler' }));
    expect(onToggleSpoiler).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: 'Mark f2 as spoiler' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark f3 as spoiler' })).not.toBeInTheDocument();
  });

  it('shows a marked draft blurred, labelled, with the toggle pressed', () => {
    const { container } = render(
      <AttachmentTray drafts={[draft(1, 'image/png', { spoiler: true })]} onRemove={() => {}} onToggleSpoiler={() => {}} />
    );

    expect(container.querySelector('.attachment-draft.spoiler')).not.toBeNull();
    expect(screen.getByText('Spoiler')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove spoiler from f1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens a clicked image in the viewer, with the tray\'s other images', () => {
    const openImage = vi.fn();
    render(
      <ImageViewerContext.Provider value={{ openImage }}>
        <AttachmentTray
          drafts={[draft(1, 'image/png'), draft(2, 'application/pdf'), draft(3, 'image/gif', { width: 40, height: 30 })]}
          onRemove={() => {}}
        />
      </ImageViewerContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'View f3' }));
    expect(openImage).toHaveBeenCalledWith({
      images: [
        { src: 'blob:1', name: 'f1', size: 1, width: undefined, height: undefined },
        { src: 'blob:3', name: 'f3', size: 1, width: 40, height: 30 },
      ],
      index: 1,
    });
    expect(screen.queryByRole('button', { name: 'View f2' })).not.toBeInTheDocument();
  });
});
