// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/gifService', () => ({
  trendingGifs: vi.fn(),
  searchGifs: vi.fn(),
  getGifFavorites: vi.fn(),
  addGifFavorite: vi.fn(),
  removeGifFavorite: vi.fn(),
}));

import * as gifService from '../services/gifService';
import EmojiPicker from './EmojiPicker';
import { ConfigContext } from '../contexts';
import { EmojiContext } from '../emoji/emojiContext';

const gif = (id, title = `GIF ${id}`) => ({
  id: String(id), title, url: `https://static.klipy.com/${id}.webp`, width: 400, height: 300,
  preview: `https://static.klipy.com/${id}-sm.webp`, previewWidth: 200, previewHeight: 150,
});

function renderPicker({ gifsEnabled = true, onGif = vi.fn() } = {}) {
  const onClose = vi.fn();
  render(
    <ConfigContext.Provider value={{ gifsEnabled, s3Endpoint: 'https://s3' }}>
      <EmojiContext.Provider value={null}>
        <EmojiPicker onSelect={vi.fn()} onGif={onGif} onClose={onClose} />
      </EmojiContext.Provider>
    </ConfigContext.Provider>
  );
  return { onGif, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  gifService.trendingGifs.mockResolvedValue({ gifs: [gif(1, 'Trending one')], next: null });
  gifService.searchGifs.mockResolvedValue({ gifs: [gif(2, 'A cat')], next: null });
  gifService.getGifFavorites.mockResolvedValue([]);
  gifService.addGifFavorite.mockResolvedValue({});
  gifService.removeGifFavorite.mockResolvedValue({});
});

describe('GIFs tab', () => {
  it('only exists when the server has GIFs set up', () => {
    renderPicker({ gifsEnabled: false });
    expect(screen.queryByRole('tab', { name: 'GIFs' })).not.toBeInTheDocument();
  });

  it('shows trending, searches, and sends the picked GIF', async () => {
    const { onGif, onClose } = renderPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'GIFs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trending one' }));
    expect(onGif).toHaveBeenCalledWith(gif(1, 'Trending one'));
    expect(onClose).toHaveBeenCalled();
  });

  it('searches with the shared search box', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'GIFs' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search GIFs' }), { target: { value: 'cats' } });
    expect(await screen.findByRole('button', { name: 'A cat' }, { timeout: 2000 })).toBeInTheDocument();
    expect(gifService.searchGifs).toHaveBeenCalledWith('cats', 1, expect.anything());
  });

  it('remembers the tab, and keeps favourites', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'GIFs' }));
    expect(localStorage.getItem('emojiPickerTab')).toBe('gifs');
    await screen.findByRole('button', { name: 'Trending one' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to favourites' }));
    });
    expect(gifService.addGifFavorite).toHaveBeenCalledWith(gif(1, 'Trending one'));

    fireEvent.click(screen.getByRole('tab', { name: 'Favourites (1)' }));
    expect(screen.getByRole('button', { name: 'Trending one' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from favourites' }));
    await waitFor(() => expect(gifService.removeGifFavorite).toHaveBeenCalledWith('1'));
    expect(screen.getByText(/No favourites yet/)).toBeInTheDocument();
  });
});
