import api from '../utils/api';

// GIFs from Klipy, through our server (server/routes/gifs.js), which keeps the API key.
// A gif is { id, title, url, width, height, preview, previewWidth, previewHeight }; lists come
// as { gifs, next } (next: the page after, or null).

export async function trendingGifs(page = 1, signal) {
  const { data } = await api.get('/gifs/trending', { params: { page }, signal });
  return data;
}

export async function searchGifs(q, page = 1, signal) {
  const { data } = await api.get('/gifs/search', { params: { q, page }, signal });
  return data;
}

// Favourites are kept on the server, so they follow you to your other devices.
export async function getGifFavorites() {
  const { data } = await api.get('/gif-favorites');
  return data.favorites;
}

export function addGifFavorite(gif) {
  return api.put(`/gif-favorites/${encodeURIComponent(gif.id)}`, { gif });
}

export function removeGifFavorite(id) {
  return api.delete(`/gif-favorites/${encodeURIComponent(id)}`);
}
