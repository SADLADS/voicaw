import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { frequentEmojiIds, getSkinTone, recordEmojiUse, setSkinTone, skinFor } from '../emoji/emojiUsage';
import { customEmojiText, customEmojiUrl, customUsageId, searchCustomEmoji } from '../emoji/customEmoji';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import { ConfigContext } from '../contexts';
import GuildIcon from './guild/GuildIcon';
import GifPicker from './GifPicker';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClock } from '@fortawesome/free-solid-svg-icons';
import { useVisualViewport } from '../utils/useVisualViewport';
import { hasVirtualKeyboardApi, setKeyboardOverlaysContent, watchKeyboardRect } from '../utils/virtualKeyboard';

// `?kbdebug` in the URL shows the keyboard/viewport numbers during mobile emoji search.
const KEYBOARD_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('kbdebug');

const TONE_SAMPLE = 'raised_hand';

// The tab (Emoji or GIFs) the picker last had open, per device.
const TAB_KEY = 'emojiPickerTab';
function savedTab() {
  try { return localStorage.getItem(TAB_KEY) === 'gifs' ? 'gifs' : 'emoji'; } catch { return 'emoji'; }
}

// Emoji images only load once they're within a screen of the picker's visible area. The
// browser's own `loading="lazy"` looks much further ahead (hundreds of images on open), so
// the emoji actually on screen had to queue behind ones nobody could see yet.
const NearbyContext = createContext(null);
const CAN_OBSERVE = typeof IntersectionObserver !== 'undefined';

function useNearbyObserver(rootRef, ready) {
  const [observer, setObserver] = useState(null);
  useEffect(() => {
    if (!CAN_OBSERVE || !ready || !rootRef.current) return undefined;
    const callbacks = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        callbacks.get(entry.target)?.();
        callbacks.delete(entry.target);
        io.unobserve(entry.target);
      }
    }, { root: rootRef.current, rootMargin: '100% 0px' });
    setObserver({
      watch(el, onNear) {
        callbacks.set(el, onNear);
        io.observe(el);
        return () => { callbacks.delete(el); io.unobserve(el); };
      },
    });
    return () => io.disconnect();
  }, [rootRef, ready]);
  return observer;
}

function EmojiImage({ unified, src, alt }) {
  const nearby = useContext(NearbyContext);
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => (nearby && !near ? nearby.watch(ref.current, () => setNear(true)) : undefined), [nearby, near]);
  // Without IntersectionObserver (old browsers, tests) fall back to the browser's lazy loading.
  const show = near || !CAN_OBSERVE;
  return (
    <img
      ref={ref}
      className="emoji"
      src={show ? src ?? emojiImageUrl(unified) : undefined}
      alt={alt}
      loading={CAN_OBSERVE ? undefined : 'lazy'}
      draggable={false}
    />
  );
}

function EmojiButton({ emoji, tone, onPick, onHover, keepFocus }) {
  const skin = skinFor(emoji, tone);
  return (
    <button
      type="button"
      className="emoji-picker-item"
      onClick={(e) => onPick(emoji, skin, e)}
      // While searching on mobile, don't let the tap take focus from the search box: the
      // blur would shrink the picker mid-tap and the tap could land on a different emoji.
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      onMouseEnter={() => onHover(emoji)}
      onFocus={() => onHover(emoji)}
      aria-label={emoji.name}
      title={`:${emoji.id}:`}
    >
      <EmojiImage unified={skin.unified} alt={skin.native} />
    </button>
  );
}

// A custom (guild) emoji in the grid.
function CustomEmojiButton({ emoji, s3Endpoint, onPick, onHover, keepFocus }) {
  return (
    <button
      type="button"
      className="emoji-picker-item"
      onClick={(e) => onPick(emoji, null, e)}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      onMouseEnter={() => onHover(emoji)}
      onFocus={() => onHover(emoji)}
      aria-label={`:${emoji.name}:`}
      title={`:${emoji.name}: (${emoji.guild.name})`}
    >
      <EmojiImage src={customEmojiUrl(emoji.id, s3Endpoint)} alt={`:${emoji.name}:`} />
    </button>
  );
}

// Discord-style picker: search, categories, frequently used, skin tone. `onSelect(text)` gets
// the Unicode emoji, or `<:name:id>` for a custom one; shift+click picks without closing.
// The custom emoji of each of your guilds come after Frequently Used and before the standard
// categories, in your guild rail order, with the guild's icon in the category bar.
// `autoFocus` focuses the search box on open.
//
// With `onGif` (the message box, when the server has GIFs set up) there's a GIFs tab too
// (GifPicker, from Klipy, sharing the search box): picking one calls `onGif(gif)` and closes.
//
// `docked` (mobile): the picker takes the on-screen keyboard's place, `height` tall, instead
// of floating over the chat, and has no hover preview (touch screens don't hover). Its
// search box isn't focused on open (that would summon the keyboard); tapping it does, and the
// picker then goes full screen above the keyboard for searching. Picking or going back
// returns to the docked panel and dismisses the keyboard.
export default function EmojiPicker({ onSelect, onGif, onClose, autoFocus = true, docked = false, height }) {
  const index = useEmojiIndex();
  const custom = useCustomEmoji();
  const { s3Endpoint, gifsEnabled } = useContext(ConfigContext) ?? {};
  const hasGifs = Boolean(onGif && gifsEnabled);
  const [tab, setTabState] = useState(savedTab);
  const gifTab = hasGifs && tab === 'gifs';
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(getSkinTone);
  const [showTones, setShowTones] = useState(false);
  const [hovered, setHovered] = useState(null);
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const searchRef = useRef(null);
  const nearby = useNearbyObserver(scrollRef, Boolean(index));
  // Docked only: full-screen search mode (keyboard open).
  const [searching, setSearching] = useState(false);
  const visible = useVisualViewport(docked && searching);
  // Whether the keyboard has come up during this search (so its closing can be noticed).
  const keyboardSeen = useRef(false);
  // Chromium: exact keyboard geometry (see utils/virtualKeyboard.js); others: visual viewport.
  const useKeyboardApi = docked && hasVirtualKeyboardApi();
  const [keyboardRect, setKeyboardRect] = useState(null);
  const keyboardOpen = useKeyboardApi ? (keyboardRect?.height ?? 0) > 0 : visible.keyboardOpen;

  useEffect(() => {
    if (!useKeyboardApi || !searching) return undefined;
    return watchKeyboardRect(setKeyboardRect);
  }, [useKeyboardApi, searching]);

  // Never leave the keyboard overlaying the page once the picker is gone.
  useEffect(() => () => { if (docked) setKeyboardOverlaysContent(false); }, [docked]);

  // Close on outside click or Escape. The Escape is marked handled, so a dialog the picker is
  // open over (Modal) stays open.
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (autoFocus && !docked) searchRef.current?.focus();
  }, [autoFocus, docked]);

  const sections = useMemo(() => {
    if (!index) return [];
    const frequent = frequentEmojiIds()
      .map((id) => (id.startsWith('custom:') ? custom.byId.get(id.slice(7)) : index.emojis.get(id)))
      .filter(Boolean);
    return [
      ...(frequent.length ? [{ id: 'frequent', name: 'Frequently Used', emojis: frequent }] : []),
      ...custom.guilds.map(({ guild, emojis }) => ({ id: `guild-${guild.id}`, name: guild.name, guild, emojis })),
      ...index.categories,
    ];
  }, [index, custom]);

  // Custom emoji first (their names are what people search for), then the standard ones.
  const results = useMemo(
    () => (index && query.trim() ? [...searchCustomEmoji(custom, query, 60), ...index.search(query, 120)] : null),
    [index, custom, query]
  );

  // The keyboard went away (search box lost focus, or e.g. Android's back button closed the
  // keyboard while the box kept focus): back to the docked size, keeping the results.
  const keyboardClosed = () => {
    keyboardSeen.current = false;
    setKeyboardOverlaysContent(false);
    setSearching(false);
  };

  useEffect(() => {
    if (!docked || !searching) return;
    if (keyboardOpen) {
      keyboardSeen.current = true;
    } else if (keyboardSeen.current) {
      searchRef.current?.blur();
      keyboardClosed();
    }
  }, [docked, searching, keyboardOpen]);

  const stopSearching = () => {
    keyboardSeen.current = false;
    setKeyboardOverlaysContent(false);
    setSearching(false);
    setQuery('');
    searchRef.current?.blur(); // dismisses the keyboard
  };

  const setTab = (value) => {
    setTabState(value);
    setQuery('');
    try { localStorage.setItem(TAB_KEY, value); } catch { /* private mode */ }
  };

  const pickGif = (gif) => {
    onGif(gif);
    if (docked && searching) stopSearching();
    onClose();
  };

  const pick = (emoji, skin, event) => {
    if (emoji.guild) {
      recordEmojiUse(customUsageId(emoji.id));
      onSelect(customEmojiText(emoji));
    } else {
      recordEmojiUse(emoji.id);
      onSelect(skin.native);
    }
    // Docked (mobile) it stays open like a keyboard (leaving search mode); floating,
    // shift+click keeps it open.
    if (docked) {
      if (searching) stopSearching();
    } else if (!event?.shiftKey) {
      onClose();
    }
  };

  const onSearchKeyDown = (e) => {
    // GIFs: Enter just puts the keyboard away (the results are already showing).
    if (gifTab) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (docked) e.currentTarget.blur();
      }
      return;
    }
    // Enter (the keyboard's search key on mobile) picks the top result.
    if (e.key === 'Enter' && results?.length) {
      e.preventDefault();
      pick(results[0], results[0].guild ? null : skinFor(results[0], tone), e);
    }
  };

  const chooseTone = (value) => {
    setTone(value);
    setSkinTone(value);
    setShowTones(false);
  };

  const jumpTo = (sectionId) => {
    setQuery('');
    requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector(`[data-section="${sectionId}"]`);
      if (target) scrollRef.current.scrollTop = target.offsetTop - scrollRef.current.offsetTop;
    });
  };

  // Full-screen search geometry.
  function searchBox() {
    if (useKeyboardApi) {
      // The keyboard overlays the page, so the picker fills the whole screen and runs on
      // under the keyboard; only its content stops at the keyboard's reported top. With
      // Chrome's address bar at the bottom, that report is off by the bar's height (the real
      // keyboard sits lower), so sizing the picker to it left the chat showing in between.
      const inset = keyboardOpen ? Math.max(0, window.innerHeight - keyboardRect.y) : 0;
      return { top: '0px', bottom: '0px', paddingBottom: `${inset}px` };
    }
    return { top: `${visible.offsetTop}px`, height: `${visible.height + 1}px` };
  }

  const toneSample = index?.byShortcode.get(TONE_SAMPLE);
  const preview = hovered && !hovered.guild && skinFor(hovered, tone);
  const renderItem = (emoji) => (emoji.guild
    ? <CustomEmojiButton key={`c${emoji.id}`} emoji={emoji} s3Endpoint={s3Endpoint} onPick={pick} onHover={setHovered} keepFocus={docked && searching} />
    : <EmojiButton key={emoji.id} emoji={emoji} tone={tone} onPick={pick} onHover={setHovered} keepFocus={docked && searching} />);

  return (
    <div
      className={`emoji-picker${docked ? ' docked' : ''}${docked && searching ? ' searching' : ''}${gifTab ? ' gifs' : ''}`}
      style={
        docked && searching
          // Picker plus keyboard fill the screen, with no sliver of the page between them.
          ? searchBox()
          : docked && height ? { height: `${height}px` } : undefined
      }
      ref={rootRef}
      role="dialog"
      aria-label="Emoji picker"
    >
      {hasGifs && !(docked && searching) && (
        <div className="emoji-picker-tabs" role="tablist" aria-label="Picker">
          {[['emoji', 'Emoji'], ['gifs', 'GIFs']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={(id === 'gifs') === gifTab}
              className={(id === 'gifs') === gifTab ? 'active' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker-header">
        {docked && searching && (
          <button type="button" className="emoji-picker-back" onClick={stopSearching} aria-label="Close search">
            ←
          </button>
        )}
        <input
          ref={searchRef}
          className="emoji-picker-search"
          type="search"
          enterKeyHint="search"
          placeholder={gifTab ? 'Search KLIPY' : 'Find the perfect emoji'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          // Docked: tapping the box opens the keyboard (a real tap, so iOS allows it) and goes full screen.
          // Chromium: have the keyboard overlay the page (exact geometry) before it opens.
          onPointerDown={docked ? () => setKeyboardOverlaysContent(true) : undefined}
          onFocus={docked ? () => { setKeyboardOverlaysContent(true); setSearching(true); } : undefined}
          onBlur={docked ? keyboardClosed : undefined}
          aria-label={gifTab ? 'Search GIFs' : 'Search emoji'}
        />
        {toneSample && !gifTab && !(docked && searching) && (
          <div className="emoji-picker-tones">
            <button
              type="button"
              className="emoji-picker-tone-toggle"
              onClick={() => setShowTones((v) => !v)}
              aria-label="Skin tone"
              aria-expanded={showTones}
            >
              <img className="emoji" src={emojiImageUrl(skinFor(toneSample, tone).unified)} alt="" draggable={false} />
            </button>
            {showTones && (
              <div className="emoji-picker-tone-menu" role="menu">
                {toneSample.skins.map((skin, value) => (
                  <button
                    key={skin.unified}
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === tone}
                    aria-label={`Skin tone ${value}`}
                    onClick={() => chooseTone(value)}
                  >
                    <img className="emoji" src={emojiImageUrl(skin.unified)} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {gifTab ? (
        <GifPicker query={query} onPick={pickGif} keepFocus={docked && searching} />
      ) : !index ? (
        <div className="emoji-picker-empty">Loading emoji…</div>
      ) : (
        <div className="emoji-picker-body">
          {!results && (
            <nav className="emoji-picker-nav" aria-label="Emoji categories">
              {sections.map((section) => (
                <button key={section.id} type="button" onClick={() => jumpTo(section.id)} title={section.name} aria-label={section.name}>
                  {section.guild ? (
                    <GuildIcon guild={section.guild} className="emoji-picker-guild-icon" />
                  ) : section.id === 'frequent' ? (
                    <FontAwesomeIcon icon={faClock} className="emoji-picker-frequent-icon" />
                  ) : (
                    <img className="emoji" src={emojiImageUrl(section.emojis[0].skins[0].unified)} alt="" draggable={false} />
                  )}
                </button>
              ))}
            </nav>
          )}
          <div className="emoji-picker-scroll" ref={scrollRef}>
            <NearbyContext.Provider value={nearby}>
              {results ? (
                results.length ? (
                  <div className="emoji-picker-grid">
                    {results.map(renderItem)}
                  </div>
                ) : (
                  <div className="emoji-picker-empty">No emoji match "{query}"</div>
                )
              ) : (
                sections.map((section) => (
                  <section key={section.id} data-section={section.id}>
                    <h6 className="emoji-picker-section-title">{section.name}</h6>
                    <div className="emoji-picker-grid">
                      {section.emojis.map(renderItem)}
                    </div>
                  </section>
                ))
              )}
            </NearbyContext.Provider>
          </div>
        </div>
      )}

      {KEYBOARD_DEBUG && docked && searching && (
        <pre className="emoji-picker-kbdebug">
          {JSON.stringify({
            innerHeight: window.innerHeight,
            visualViewport: { height: visible.height, offsetTop: visible.offsetTop },
            keyboardApi: useKeyboardApi,
            keyboardRect: keyboardRect && { y: keyboardRect.y, height: keyboardRect.height },
            picker: searchBox(),
          }, null, 1)}
        </pre>
      )}

      {!docked && !gifTab && (
        <div className="emoji-picker-preview">
          {hovered?.guild ? (
            <>
              <img className="emoji" src={customEmojiUrl(hovered.id, s3Endpoint)} alt="" draggable={false} />
              <span className="emoji-picker-preview-code">:{hovered.name}:</span>
              <span className="emoji-picker-preview-from">from {hovered.guild.name}</span>
            </>
          ) : preview ? (
            <>
              <img className="emoji" src={emojiImageUrl(preview.unified)} alt="" draggable={false} />
              <span className="emoji-picker-preview-code">:{hovered.id}:</span>
            </>
          ) : (
            <span className="emoji-picker-preview-name">Pick an emoji</span>
          )}
        </div>
      )}
    </div>
  );
}
