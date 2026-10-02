import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faHashtag, faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from '../Avatar';
import defaultAvatar from '../../assets/images/default.png';
import { MessageContent } from '../MessageList';
import { ConfigContext, NsfwChannelContext } from '../../contexts';
import { searchGuildMessages } from '../../services/guildService';
import { toChatMessage } from '../../hooks/useChannel';
import { parseSearch, searchContext, searchSuggestions } from '../../utils/searchQuery';
import { displayName, nameOf, useProfiles } from '../../utils/profiles';
import { formatDateTime, useDateFormat } from '../../utils/dateFormat';

const MARGIN = 8;

const KEY_HINTS = {
  from: 'user',
  mentions: 'user',
  in: 'channel',
  has: 'link, embed, file, image, video, sound or poll',
};

// Searching the guild (server side, routes/guildSearch.js): words plus from:, mentions:, in:
// and has: (utils/searchQuery.js), with suggestions for them while typing. On a computer the
// box sits in the channel header and results float under it, like the pinned messages; on a
// phone the header has a button that opens both over the whole screen. Jump (`onJump`, given
// the message with its channel_id) opens the message in its channel.
export default function GuildSearch({ guild, members, user, isMobile, onJump, reactionNames, mentionRoles, nameColors }) {
  useProfiles();
  useDateFormat();
  const { s3Endpoint } = useContext(ConfigContext);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Mobile: the full-screen panel is open (with or without results).
  const [mobileOpen, setMobileOpen] = useState(false);
  // The search being shown: { params, sort }, and its results.
  const [search, setSearch] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const boxRef = useRef(null);
  const [anchor, setAnchor] = useState(null);

  const channels = useMemo(() => guild.channels.filter((c) => c.type === 'text'), [guild.channels]);
  const channelName = (id) => guild.channels.find((c) => c.id === id)?.name ?? 'unknown';
  // A result from an NSFW channel has its media covered, as in the channel.
  const isNsfw = (id) => Boolean(guild.channels.find((c) => c.id === id)?.nsfw);

  const context = focused ? searchContext(text, caret) : null;
  const suggestions = searchSuggestions(context, { members, channels, nameOf });

  // A new guild: start again.
  useEffect(() => {
    setText('');
    setSearch(null);
    setResults(null);
    setError(null);
    setMobileOpen(false);
  }, [guild.id]);

  // Runs `search` (first page), and again whenever it changes.
  useEffect(() => {
    if (!search) return undefined;
    let cancelled = false;
    setLoading(true);
    setResults(null);
    setError(null);
    searchGuildMessages(guild.id, { ...search.params, sort_order: search.sort })
      .then((data) => { if (!cancelled) setResults({ total: data.total_results, messages: data.messages.map(toChatMessage) }); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || "Couldn't search right now."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [search, guild.id]);

  async function loadMore() {
    if (!search || !results || loading) return;
    setLoading(true);
    try {
      const data = await searchGuildMessages(guild.id, { ...search.params, sort_order: search.sort, offset: results.messages.length });
      setResults((prev) => ({
        total: data.total_results,
        messages: [...prev.messages, ...data.messages.map(toChatMessage).filter((m) => !prev.messages.some((p) => p.id === m.id))],
      }));
    } catch (err) {
      setError(err.response?.data?.error || "Couldn't load more results.");
    } finally {
      setLoading(false);
    }
  }

  function submit() {
    const { params, problems, empty } = parseSearch(text, { members, channels });
    if (empty && !problems.length) return;
    if (!isMobile && boxRef.current) setAnchor(boxRef.current.getBoundingClientRect());
    inputRef.current?.blur();
    if (problems.length) {
      setSearch(null);
      setResults(null);
      setError(problems.join('. '));
      return;
    }
    setSearch((prev) => ({ params, sort: prev?.sort ?? 'desc' }));
  }

  function pick(item) {
    const start = context.start;
    const next = text.slice(0, start) + item.insert + text.slice(caret);
    const position = start + item.insert.length;
    setText(next);
    setCaret(position);
    setActiveIndex(0);
    pendingCaret.current = position;
  }

  // After a pick, the caret goes after what it wrote (once the new text is in the box).
  const pendingCaret = useRef(null);
  useLayoutEffect(() => {
    if (pendingCaret.current == null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  function closeResults() {
    setSearch(null);
    setResults(null);
    setError(null);
    setAnchor(null);
    if (isMobile) setMobileOpen(false);
  }

  function clear() {
    setText('');
    setCaret(0);
    closeResults();
    if (isMobile) setMobileOpen(true);
    inputRef.current?.focus();
  }

  // Enter searches once the word is already what the highlighted suggestion would write.
  const highlighted = suggestions[Math.min(activeIndex, suggestions.length - 1)];
  const typedInFull = Boolean(highlighted && context &&
    highlighted.insert.trim().toLowerCase() === text.slice(context.start, caret).toLowerCase());

  function onKeyDown(e) {
    if (suggestions.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (suggestions.length && (e.key === 'Tab' || (e.key === 'Enter' && context.kind !== 'keys' && context.value !== '' && !typedInFull))) {
      e.preventDefault();
      pick(highlighted);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (suggestions.length) inputRef.current?.blur();
      else closeResults();
    }
  }

  const trackCaret = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);

  const showPanel = isMobile ? mobileOpen : Boolean(search || error);

  // Desktop: a click elsewhere (not in the box, the results or a dialog) closes the results.
  useEffect(() => {
    if (!showPanel || isMobile) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('.search-panel, .guild-search, .modal-backdrop, .image-viewer')) closeResults();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPanel, isMobile]);

  const input = (
    <div className="guild-search" ref={boxRef}>
      <input
        ref={inputRef}
        type="search"
        className="guild-search-input"
        placeholder={`Search ${guild.name}`}
        aria-label="Search this guild"
        value={text}
        enterKeyHint="search"
        autoComplete="off"
        onChange={(e) => { setText(e.target.value); trackCaret(e); setActiveIndex(0); }}
        onSelect={trackCaret}
        onKeyDown={onKeyDown}
        onFocus={(e) => { setFocused(true); trackCaret(e); }}
        onBlur={() => setFocused(false)}
      />
      {text ? (
        <button type="button" className="guild-search-icon clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
          <FontAwesomeIcon icon={faXmark} />
        </button>
      ) : (
        <span className="guild-search-icon" aria-hidden="true"><FontAwesomeIcon icon={faMagnifyingGlass} /></span>
      )}
      {suggestions.length > 0 && (
        <div className="emoji-suggestions guild-search-suggestions" role="listbox" aria-label="Search options">
          <div className="emoji-suggestions-title">
            {context.kind === 'keys' ? 'Search options' : context.kind === 'in' ? 'Channels' : context.kind === 'has' ? 'Message contains' : 'Members'}
          </div>
          {suggestions.map((item, i) => (
            <div
              key={`${item.kind}-${item.id ?? item.label ?? item.key}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`emoji-suggestion guild-search-suggestion${i === activeIndex ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {item.kind === 'key' && (<><strong>{item.key}:</strong><span className="mention-suggestion-note">{KEY_HINTS[item.key]}</span></>)}
              {item.kind === 'has' && <span>{item.label}</span>}
              {item.kind === 'channel' && (<><FontAwesomeIcon icon={faHashtag} className="guild-search-hash" /><span>{item.label}</span></>)}
              {item.kind === 'member' && (
                <>
                  <Avatar userId={item.id} className="mention-suggestion-avatar" />
                  <span>{item.label}</span>
                  {item.username !== item.label && <span className="mention-suggestion-note">{item.username}</span>}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const style = isMobile || !anchor ? undefined : {
    top: anchor.bottom + MARGIN,
    right: Math.max(MARGIN, window.innerWidth - anchor.right),
  };

  const panel = showPanel && createPortal(
    <div className={`pins-panel search-panel${isMobile ? ' mobile' : ''}`} style={style} role="dialog" aria-label="Search results">
      <div className="pins-panel-header">
        {isMobile ? (
          <>
            <button type="button" className="icon-button" aria-label="Close search" onClick={closeResults}>
              <FontAwesomeIcon icon={faArrowLeft} />
            </button>
            {input}
          </>
        ) : (
          <>
            <h5>{results ? `${results.total} ${results.total === 1 ? 'result' : 'results'}` : 'Search'}</h5>
            <button type="button" className="icon-button" aria-label="Close" onClick={closeResults}>
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </>
        )}
      </div>
      {search && (
        <div className="search-panel-sort">
          {isMobile && results && <span>{results.total} {results.total === 1 ? 'result' : 'results'}</span>}
          <span className="search-panel-sort-buttons" role="group" aria-label="Sort">
            {[['desc', 'Newest'], ['asc', 'Oldest']].map(([sort, label]) => (
              <button
                key={sort}
                type="button"
                className={`btn btn-sm${search.sort === sort ? ' active' : ''}`}
                aria-pressed={search.sort === sort}
                onClick={() => setSearch((prev) => ({ ...prev, sort }))}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="pins-panel-list">
        {error && <p className="error-text pins-panel-note">{error}</p>}
        {!search && !error && isMobile && (
          <p className="pins-panel-note">Search for words, or narrow it down with from:, mentions:, in: and has:.</p>
        )}
        {results?.messages.length === 0 && (
          <div className="pins-panel-empty"><p>No results.</p><p className="vc-hint">Try other words or fewer filters.</p></div>
        )}
        {results?.messages.map((msg) => {
          const name = msg.webhook_id ? msg.webhook_name : displayName(msg.sender_id, msg.sender_username);
          return (
            <div key={msg.id} className="pinned-message search-result" data-result-id={msg.id}>
              <div className="search-result-channel">
                <FontAwesomeIcon icon={faHashtag} /> {channelName(msg.channel_id)}
              </div>
              <div className="pinned-message-header">
                {msg.webhook_id ? (
                  <img src={msg.webhook_avatar || defaultAvatar} alt={name} className="pinned-message-avatar" referrerPolicy="no-referrer" />
                ) : (
                  <Avatar userId={msg.sender_id} alt={name} className="pinned-message-avatar" />
                )}
                <strong style={{ color: nameColors?.[msg.sender_id] }}>{name}</strong>
                <small title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>{formatDateTime(msg.timestamp * 1000)}</small>
                <span className="pinned-message-actions">
                  <button
                    type="button"
                    className="btn btn-sm pinned-message-jump"
                    onClick={() => {
                      if (isMobile) setMobileOpen(false);
                      onJump(msg);
                    }}
                  >
                    Jump
                  </button>
                </span>
              </div>
              <NsfwChannelContext.Provider value={isNsfw(msg.channel_id)}>
                <MessageContent
                  msg={msg}
                  user={user}
                  s3Endpoint={s3Endpoint}
                  reactionNames={reactionNames}
                  mentionRoles={mentionRoles}
                  myRoleIds={guild.my_role_ids}
                />
              </NsfwChannelContext.Provider>
            </div>
          );
        })}
        {loading && <p className="pins-panel-note">Searching…</p>}
        {results && !loading && results.messages.length < results.total && (
          <button type="button" className="btn btn-sm search-panel-more" onClick={loadMore}>Load more</button>
        )}
      </div>
    </div>,
    document.body
  );

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className={`channel-header-button search-button${mobileOpen ? ' active' : ''}`}
          aria-label="Search"
          title="Search"
          onClick={() => {
            setMobileOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </button>
        {panel}
      </>
    );
  }
  return (
    <>
      {input}
      {panel}
    </>
  );
}
