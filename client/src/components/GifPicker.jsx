import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/free-solid-svg-icons';
import {
  addGifFavorite,
  getGifFavorites,
  removeGifFavorite,
  searchGifs,
  trendingGifs,
} from '../services/gifService';

const SEARCH_DELAY_MS = 300;
const COLUMNS = 2;

// Favourites, kept between openings of the picker (refreshed from the server on each).
let favoritesCache = null;

function useGifFavorites() {
  const [favorites, setFavorites] = useState(favoritesCache ?? []);
  useEffect(() => {
    let live = true;
    getGifFavorites().then(
      (list) => { if (live) { favoritesCache = list; setFavorites(list); } },
      () => {}
    );
    return () => { live = false; };
  }, []);

  const update = useCallback((next) => {
    favoritesCache = next;
    setFavorites(next);
  }, []);

  const toggle = useCallback((gif) => {
    const current = favoritesCache ?? [];
    const had = current.some((g) => g.id === gif.id);
    // Optimistic; put it back as it was if the server says no.
    update(had ? current.filter((g) => g.id !== gif.id) : [gif, ...current]);
    (had ? removeGifFavorite(gif.id) : addGifFavorite(gif)).catch(() => update(current));
  }, [update]);

  return { favorites, toggle };
}

// Trending (empty query) or search results, a page at a time.
function useGifResults(query, enabled) {
  const [state, setState] = useState({ gifs: [], next: 1, loading: false, error: null });
  const request = useRef(null);

  const load = useCallback((page, reset) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((s) => ({ ...(reset ? { gifs: [], next: null } : s), loading: true, error: null }));
    const fetchPage = query ? searchGifs(query, page, controller.signal) : trendingGifs(page, controller.signal);
    fetchPage.then(
      ({ gifs, next }) => {
        if (controller.signal.aborted) return;
        setState((s) => {
          const seen = new Set(s.gifs.map((g) => g.id));
          return { gifs: [...s.gifs, ...gifs.filter((g) => !seen.has(g.id))], next, loading: false, error: null };
        });
      },
      (err) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: err.response?.data?.error || "Couldn't load GIFs" }));
      }
    );
  }, [query]);

  useEffect(() => {
    if (!enabled) return undefined;
    load(1, true);
    return () => request.current?.abort();
  }, [load, enabled]);

  const loadMore = useCallback(() => {
    if (!state.loading && state.next && !state.error) load(state.next, false);
  }, [state, load]);

  return { ...state, loadMore };
}

// Masonry: each GIF goes into the column that's shortest so far, so pages can be appended
// without anything above moving.
function toColumns(gifs) {
  const columns = Array.from({ length: COLUMNS }, () => ({ height: 0, gifs: [] }));
  for (const gif of gifs) {
    const column = columns.reduce((a, b) => (b.height < a.height ? b : a));
    column.gifs.push(gif);
    column.height += (gif.previewHeight || 1) / (gif.previewWidth || 1);
  }
  return columns.map((c) => c.gifs);
}

function GifTile({ gif, favorite, onPick, onToggleFavorite, keepFocus }) {
  const noFocusSteal = keepFocus ? (e) => e.preventDefault() : undefined;
  return (
    <div className="gif-tile" style={{ aspectRatio: `${gif.previewWidth} / ${gif.previewHeight}` }}>
      <button
        type="button"
        className="gif-tile-pick"
        onClick={() => onPick(gif)}
        onMouseDown={noFocusSteal}
        aria-label={gif.title || 'GIF'}
        title={gif.title || undefined}
      >
        <img src={gif.preview} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
      </button>
      <button
        type="button"
        className={`gif-tile-favorite${favorite ? ' on' : ''}`}
        onClick={() => onToggleFavorite(gif)}
        onMouseDown={noFocusSteal}
        aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={favorite}
      >
        <FontAwesomeIcon icon={faStar} />
      </button>
    </div>
  );
}

// The emoji picker's GIFs tab (Klipy). `query` is the picker's search box. Without a query it
// shows Trending or your Favourites; picking calls `onPick(gif)`. `keepFocus`: taps don't take
// focus from the search box (mobile search, see EmojiPicker).
export default function GifPicker({ query, onPick, keepFocus = false }) {
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const q = query.trim();
    if (!q) { setDebounced(''); return undefined; }
    const timer = setTimeout(() => setDebounced(q), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const [view, setView] = useState('trending');
  const showFavorites = !debounced && view === 'favorites';
  const { favorites, toggle } = useGifFavorites();
  const results = useGifResults(debounced, !showFavorites);
  const favoriteIds = useMemo(() => new Set(favorites.map((g) => g.id)), [favorites]);
  const gifs = showFavorites ? favorites : results.gifs;
  const columns = useMemo(() => toColumns(gifs), [gifs]);
  const scrollRef = useRef(null);

  // Back to the top for a new search or view.
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [debounced, showFavorites]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (!showFavorites && el.scrollTop + el.clientHeight > el.scrollHeight - 400) results.loadMore();
  };

  // A short first page may not fill the box, so there'd be nothing to scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !showFavorites && !results.loading && el.scrollHeight <= el.clientHeight + 400) results.loadMore();
  }, [results, showFavorites]);

  let empty = null;
  if (showFavorites && favorites.length === 0) empty = 'No favourites yet. Tap the star on a GIF to keep it here.';
  else if (!showFavorites && results.error) empty = results.error;
  else if (!showFavorites && !results.loading && results.gifs.length === 0) empty = debounced ? `No GIFs match "${debounced}"` : 'No GIFs';

  return (
    <div className="gif-picker">
      {!debounced && (
        <div className="gif-picker-views" role="tablist" aria-label="GIFs">
          {[['trending', 'Trending'], ['favorites', `Favourites${favorites.length ? ` (${favorites.length})` : ''}`]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={view === id ? 'active' : undefined}
              onClick={() => setView(id)}
              onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker-scroll gif-picker-scroll" ref={scrollRef} onScroll={onScroll}>
        {empty ? (
          <div className="emoji-picker-empty">{empty}</div>
        ) : (
          <div className="gif-grid">
            {columns.map((column, i) => (
              <div className="gif-column" key={i}>
                {column.map((gif) => (
                  <GifTile
                    key={gif.id}
                    gif={gif}
                    favorite={favoriteIds.has(gif.id)}
                    onPick={onPick}
                    onToggleFavorite={toggle}
                    keepFocus={keepFocus}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        {!showFavorites && results.loading && <div className="emoji-picker-empty">Loading GIFs…</div>}
        <div className="gif-picker-attribution">Powered by KLIPY</div>
      </div>
    </div>
  );
}
