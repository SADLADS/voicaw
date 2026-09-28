import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { frequentEmojiIds, getSkinTone, recordEmojiUse, setSkinTone, skinFor } from '../emoji/emojiUsage';

const TONE_SAMPLE = 'raised_hand';

function EmojiButton({ emoji, tone, onPick, onHover }) {
  const skin = skinFor(emoji, tone);
  return (
    <button
      type="button"
      className="emoji-picker-item"
      onClick={(e) => onPick(emoji, skin, e)}
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
// of floating over the chat. It has no search box there, because typing would open the
// keyboard on top of it (searching works by typing ":name" in the message box instead), and
// no hover preview (touch screens don't hover).
export default function EmojiPicker({ onSelect, onClose, autoFocus = true, docked = false, height }) {
  const index = useEmojiIndex();
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(getSkinTone);
  const [showTones, setShowTones] = useState(false);
  const [hovered, setHovered] = useState(null);
  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const searchRef = useRef(null);

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

  const pick = (emoji, skin, event) => {
    recordEmojiUse(emoji.id);
    onSelect(skin.native);
    // Docked (mobile) it stays open like a keyboard; floating, shift+click keeps it open.
    if (!docked && !event?.shiftKey) onClose();
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

  const toneSample = index?.byShortcode.get(TONE_SAMPLE);
  const preview = hovered && skinFor(hovered, tone);

  return (
    <div
      className={`emoji-picker${docked ? ' docked' : ''}`}
      style={docked && height ? { height: `${height}px` } : undefined}
      ref={rootRef}
      role="dialog"
      aria-label="Emoji picker"
    >
      <div className="emoji-picker-header">
        {docked ? (
          <span className="emoji-picker-title">Emoji</span>
        ) : (
          <input
            ref={searchRef}
            className="emoji-picker-search"
            type="search"
            placeholder="Find the perfect emoji"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search emoji"
          />
        )}
        {toneSample && (
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
                    <EmojiButton key={emoji.id} emoji={emoji} tone={tone} onPick={pick} onHover={setHovered} />
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
                      <EmojiButton key={emoji.id} emoji={emoji} tone={tone} onPick={pick} onHover={setHovered} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
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
