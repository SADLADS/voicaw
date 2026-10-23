import React, { useRef, useState } from 'react';
import { Icon } from '../Icon';
import { faClapperboard, faGripVertical, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useDragReorder } from '../../hooks/useDragReorder';
import {
  addMedia, addVideo, formatClock, looksLikeLink, mediaByline, mediaEpisodes, mediaIdFromLink, movedItem, moveVideo, removeVideo,
  searchMedia, searchVideos, setPlayerSlot, useWatchParty, videoIdFromInput,
} from '../../voice/watchParty';
import { closeWatchPartyWindow, useWatchPartyWindow } from '../../voice/watchPartyWindow';
import { PERMISSIONS, has } from '../../utils/permissions';
import WatchPartyActivity from './WatchPartyActivity';
import WatchPartySearchResults from './WatchPartySearchResults';
import WatchPartyMediaResults from './WatchPartyMediaResults';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const errorOf = (err) => err?.response?.data?.error ?? t('voice.watchParty.failed');

// Watch Together on a voice channel's page, once you're in its voice: paste a YouTube link to
// add it, or search YouTube and add from what it finds (WatchPartySearchResults); with the
// guild's media server (Jellyfin or Emby, `guild.media_server`) a switch beside the box searches
// it instead (WatchPartyMediaResults, shows opening to their episodes), and links to its own web
// app add that item; the player's place (WatchPartyPlayer draws itself over it, or a note while it's
// popped out into its own window), what's playing and the
// queue (dragged into order with Manage Queue; your own videos, or anyone's with Manage Queue,
// can be taken out), and who did what (WatchPartyActivity). What you may do follows the
// channel's permissions; the server decides.
export default function WatchPartyPanel({ guild, channel, myId, onClose }) {
  useProfiles();
  const party = useWatchParty(guild.id, channel.id);
  const poppedOut = useWatchPartyWindow() != null;
  const permissions = channel.my_permissions;
  const canQueue = has(permissions, PERMISSIONS.QUEUE_VIDEOS);
  const canManage = has(permissions, PERMISSIONS.MANAGE_QUEUE);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // { query, results } (results null while searching); videos added from it; the one being added.
  const [search, setSearch] = useState(null);
  const [added, setAdded] = useState(() => new Set());
  const [adding, setAdding] = useState(null);
  const latestSearch = useRef(0);
  const mediaServer = guild.media_server ?? null;
  // Where words are searched for: the media server, once the guild has one (its admins set it
  // up to be used), or YouTube.
  const [source, setSource] = useState('media');
  const searchesMedia = mediaServer != null && source === 'media';
  const isLink = !link.trim() || looksLikeLink(link) || videoIdFromInput(link) != null;
  const queue = party?.queue ?? [];
  const ids = queue.map((item) => item.id);

  const { drag, itemProps } = useDragReorder(canManage ? ids : [], (next) => {
    const moved = movedItem(ids, next);
    if (!moved) return;
    setError(null);
    moveVideo(guild.id, channel.id, moved.id, moved.beforeId).catch((err) => setError(errorOf(err)));
  });

  const closeSearch = () => {
    latestSearch.current += 1;
    setSearch(null);
  };

  // `kind` 'youtube' or 'media'; `series` (a show on the media server: { id, title }) lists its
  // episodes, `back` being the search to go back to.
  const runSearch = async (query, { kind = 'youtube', series = null, back = null } = {}) => {
    const ticket = ++latestSearch.current;
    const shown = { kind, query, series, back };
    setSearch({ ...shown, results: null });
    if (!series) setAdded(new Set());
    try {
      const results = series
        ? await mediaEpisodes(guild.id, channel.id, series.id)
        : kind === 'media' ? await searchMedia(guild.id, channel.id, query) : await searchVideos(guild.id, channel.id, query);
      if (ticket === latestSearch.current) setSearch({ ...shown, results });
    } catch (err) {
      if (ticket !== latestSearch.current) return;
      setSearch(back);
      setError(errorOf(err));
    }
  };

  const openSeries = (show) => {
    setError(null);
    runSearch(search.query, { kind: 'media', series: { id: show.media_id, title: show.title }, back: search });
  };
  const backToResults = () => {
    latestSearch.current += 1;
    setSearch(search?.back ?? null);
  };

  // A link is added; words are searched for.
  const submit = async (e) => {
    e.preventDefault();
    const text = link.trim();
    if (!text) return;
    setError(null);
    if (!isLink) {
      // On a phone the keyboard goes, so the results have the screen.
      if (document.body.classList.contains('mobile-mode')) e.currentTarget.querySelector('input')?.blur();
      runSearch(text, { kind: searchesMedia ? 'media' : 'youtube' });
      return;
    }
    const videoId = videoIdFromInput(text);
    const mediaId = videoId ? null : mediaIdFromLink(text, mediaServer?.url);
    if (!videoId && !mediaId) {
      setError(mediaServer ? t('voice.watchParty.media.notAVideo', { server: mediaServer.name }) : t('voice.watchParty.notAVideo'));
      return;
    }
    setBusy(true);
    try {
      if (mediaId) await addMedia(guild.id, channel.id, mediaId);
      else await addVideo(guild.id, channel.id, videoId);
      setLink('');
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  // A search's find: a YouTube video ({ video_id }) or the media server's ({ media_id }).
  const addFound = async (video) => {
    const key = video.media_id != null ? `media:${video.media_id}` : video.video_id;
    setAdding(key);
    setError(null);
    try {
      if (video.media_id != null) await addMedia(guild.id, channel.id, video.media_id);
      else await addVideo(guild.id, channel.id, video.video_id);
      setAdded((previous) => new Set(previous).add(key));
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setAdding(null);
    }
  };

  const remove = (item) => {
    setError(null);
    removeVideo(guild.id, channel.id, item.id).catch((err) => setError(errorOf(err)));
  };

  // Pressing a button here leaves the box focused. On a phone, the box losing focus as a finger
  // lands would bring back what typing hides (mobile.css), moving the button away before the
  // click, which then never comes.
  const keepTyping = (e) => {
    if (e.target.closest('button')) e.preventDefault();
  };

  const addedBy = (item) => t('voice.watchParty.addedBy', { name: displayName(item.added_by) });
  const byline = (item) => (item.source === 'media' ? mediaByline(item.media) : item.author);
  const placeholder = searchesMedia ? t('voice.watchParty.media.placeholder', { server: mediaServer.name }) : t('voice.watchParty.linkPlaceholder');

  return (
    <section className="watch-party-panel" aria-label={t('voice.watchParty.title')}>
      <div className="watch-party-layout">
        {party?.current && poppedOut ? (
          <div className="watch-party-slot watch-party-popped">
            <p>{t('voice.watchParty.poppedOut')}</p>
            <button type="button" className="stream-popped-button" onClick={closeWatchPartyWindow}>{t('voice.watchParty.bringBack')}</button>
          </div>
        ) : party?.current ? (
          <div className="watch-party-slot" ref={setPlayerSlot} />
        ) : (
          <div className="watch-party-empty">
            <Icon icon={faClapperboard} size="2x" />
            <p>
              {!canQueue ? t('voice.watchParty.emptyCantAdd')
                : mediaServer ? t('voice.watchParty.media.emptyCanAdd', { server: mediaServer.name }) : t('voice.watchParty.emptyCanAdd')}
            </p>
          </div>
        )}
        <div className="watch-party-side" onMouseDown={keepTyping}>
          <div className="watch-party-side-header">
            <h2>{t('voice.watchParty.title')}</h2>
            {!party?.current && onClose && (
              <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.closePanel')} title={t('voice.watchParty.closePanel')} onClick={onClose}>
                <Icon icon={faXmark} fixedWidth />
              </button>
            )}
          </div>
          {canQueue && mediaServer && (
            <div className="watch-party-sources" role="group" aria-label={t('voice.watchParty.media.searchWhere')}>
              {[['media', mediaServer.name], ['youtube', t('voice.watchParty.media.youtube')]].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`watch-party-source${source === key ? ' active' : ''}`}
                  aria-pressed={source === key}
                  onClick={() => setSource(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {canQueue && (
            <form className="watch-party-add" onSubmit={submit}>
              <input
                type="text"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                disabled={busy}
              />
              <button type="submit" className="watch-party-primary" disabled={busy || !link.trim()}>
                {isLink ? (party?.current ? t('voice.watchParty.addToQueue') : t('voice.watchParty.play')) : t('voice.watchParty.search.submit')}
              </button>
            </form>
          )}
          {error && <p className="watch-party-error" role="alert">{error}</p>}
          {canQueue && search?.kind === 'media' && (
            <WatchPartyMediaResults
              search={search}
              added={added}
              adding={adding}
              playsNow={!party?.current}
              onAdd={addFound}
              onOpenSeries={openSeries}
              onBack={backToResults}
              onClose={closeSearch}
            />
          )}
          {canQueue && search && search.kind !== 'media' && (
            <WatchPartySearchResults
              search={search}
              added={added}
              adding={adding}
              playsNow={!party?.current}
              onAdd={addFound}
              onClose={closeSearch}
            />
          )}
          {party?.current && (
            <div className="watch-party-now">
              <span className="watch-party-label">{t('voice.watchParty.nowPlaying')}</span>
              <span className="watch-party-item-title">{party.current.title ?? t('voice.watchParty.untitled')}</span>
              <span className="watch-party-item-meta">
                {[byline(party.current), party.current.duration ? formatClock(party.current.duration) : null, addedBy(party.current)].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          {party?.current && (
            <>
              <span className="watch-party-label">{t('voice.watchParty.upNext', { count: queue.length })}</span>
              {queue.length === 0 ? (
                <p className="watch-party-note">{t('voice.watchParty.queueEmpty')}</p>
              ) : (
                <ol className="watch-party-queue">
                  {queue.map((item, index) => {
                    const dragged = drag?.id === item.id;
                    const canRemove = canManage || (canQueue && item.added_by === myId);
                    return (
                      <li
                        key={item.id}
                        className={`watch-party-item${dragged ? ' dragging' : ''}${drag && !dragged && drag.targetIndex === index ? ' drop-target' : ''}`}
                        style={dragged ? { transform: `translateY(${drag.dy}px)` } : undefined}
                        {...(canManage ? itemProps(item.id) : {})}
                      >
                        {canManage && <Icon icon={faGripVertical} className="watch-party-grip" aria-hidden="true" />}
                        <span className="watch-party-item-text">
                          <span className="watch-party-item-title">{item.title ?? t('voice.watchParty.untitled')}</span>
                          <span className="watch-party-item-meta">
                            {[item.source === 'media' ? byline(item) : null, item.duration ? formatClock(item.duration) : null, addedBy(item)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {canRemove && (
                          <button
                            type="button"
                            className="watch-party-icon-button"
                            aria-label={t('voice.watchParty.remove')}
                            title={t('voice.watchParty.remove')}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => remove(item)}
                          >
                            <Icon icon={faXmark} fixedWidth />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
          <WatchPartyActivity channelId={channel.id} />
        </div>
      </div>
    </section>
  );
}
