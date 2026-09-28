import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { frequentEmojiIds, getSkinTone, recordEmojiUse, setSkinTone, skinFor } from '../emoji/emojiUsage';
import { useVisualViewport } from '../utils/useVisualViewport';
import { hasVirtualKeyboardApi, setKeyboardOverlaysContent, watchKeyboardRect } from '../utils/virtualKeyboard';

// `?kbdebug` in the URL shows the keyboard/viewport numbers during mobile emoji search.
const KEYBOARD_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('kbdebug');

const TONE_SAMPLE = 'raised_hand';

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
      <img className="emoji" src={emojiImageUrl(skin.unified)} alt={skin.native} loading="lazy" draggable={false} />
    </button>
  );
}

// Discord-style picker: search, categories, frequently used, skin tone. `onSelect(native)`;
// shift+click picks without closing. Custom (guild) emoji categories can be added later as
// extra sections. `autoFocus` focuses the search box on open.
//
// `docked` (mobile): the picker takes the on-screen keyboard's place, `height` tall, instead
// of floating over the chat, and has no hover preview (touch screens don't hover). Its
// search box isn't focused on open (that would summon the keyboard); tapping it does, and the
// picker then goes full screen above the keyboard for searching. Picking or going back
// returns to the docked panel and dismisses the keyboard.
export default function EmojiPicker({ onSelect, onClose, autoFocus = true, docked = false, height }) {
  const index = useEmojiIndex();
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(getSkinTone);
  const [showTones, setShowTones] = useState(false);
  const [hovered, setHovered] = useState(null);
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const searchRef = useRef(null);
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

  // Close on outside click or Escape.
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
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
    const frequent = frequentEmojiIds().map((id) => index.emojis.get(id)).filter(Boolean);
    return [
      ...(frequent.length ? [{ id: 'frequent', name: 'Frequently Used', emojis: frequent }] : []),
      ...index.categories,
    ];
  }, [index]);

  const results = useMemo(() => (index && query.trim() ? index.search(query, 120) : null), [index, query]);

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

  const pick = (emoji, skin, event) => {
    recordEmojiUse(emoji.id);
    onSelect(skin.native);
    // Docked (mobile) it stays open like a keyboard (leaving search mode); floating,
    // shift+click keeps it open.
    if (docked) {
      if (searching) stopSearching();
    } else if (!event?.shiftKey) {
      onClose();
    }
  };

  const onSearchKeyDown = (e) => {
    // Enter (the keyboard's search key on mobile) picks the top result.
    if (e.key === 'Enter' && results?.length) {
      e.preventDefault();
      pick(results[0], skinFor(results[0], tone), e);
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
  const preview = hovered && skinFor(hovered, tone);

  return (
    <div
      className={`emoji-picker${docked ? ' docked' : ''}${docked && searching ? ' searching' : ''}`}
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
          placeholder="Find the perfect emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          // Docked: tapping the box opens the keyboard (a real tap, so iOS allows it) and goes full screen.
          // Chromium: have the keyboard overlay the page (exact geometry) before it opens.
          onPointerDown={docked ? () => setKeyboardOverlaysContent(true) : undefined}
          onFocus={docked ? () => { setKeyboardOverlaysContent(true); setSearching(true); } : undefined}
          onBlur={docked ? keyboardClosed : undefined}
          aria-label="Search emoji"
        />
        {toneSample && !(docked && searching) && (
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

      {!index ? (
        <div className="emoji-picker-empty">Loading emoji…</div>
      ) : (
        <div className="emoji-picker-body">
          {!results && (
            <nav className="emoji-picker-nav" aria-label="Emoji categories">
              {sections.map((section) => (
                <button key={section.id} type="button" onClick={() => jumpTo(section.id)} title={section.name} aria-label={section.name}>
                  <img className="emoji" src={emojiImageUrl(section.emojis[0].skins[0].unified)} alt="" draggable={false} />
                </button>
              ))}
            </nav>
          )}
          <div className="emoji-picker-scroll" ref={scrollRef}>
            {results ? (
              results.length ? (
                <div className="emoji-picker-grid">
                  {results.map((emoji) => (
                    <EmojiButton key={emoji.id} emoji={emoji} tone={tone} onPick={pick} onHover={setHovered} keepFocus={docked && searching} />
                  ))}
                </div>
              ) : (
                <div className="emoji-picker-empty">No emoji match "{query}"</div>
              )
            ) : (
              sections.map((section) => (
                <section key={section.id} data-section={section.id}>
                  <h6 className="emoji-picker-section-title">{section.name}</h6>
                  <div className="emoji-picker-grid">
                    {section.emojis.map((emoji) => (
                      <EmojiButton key={emoji.id} emoji={emoji} tone={tone} onPick={pick} onHover={setHovered} keepFocus={docked && searching} />
                    ))}
                  </div>
                </section>
              ))
            )}
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

      {!docked && (
        <div className="emoji-picker-preview">
          {preview ? (
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
