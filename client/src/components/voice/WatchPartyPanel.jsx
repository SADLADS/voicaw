import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClapperboard, faGripVertical, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useDragReorder } from '../../hooks/useDragReorder';
import {
  addVideo, formatClock, movedItem, moveVideo, removeVideo, setPlayerSlot, useWatchParty, videoIdFromInput,
} from '../../voice/watchParty';
import { PERMISSIONS, has } from '../../utils/permissions';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const errorOf = (err) => err?.response?.data?.error ?? t('voice.watchParty.failed');

// Watch Together on a voice channel's page, once you're in its voice: paste a YouTube link to
// add it, the player's place (WatchPartyPlayer draws itself over it), what's playing and the
// queue (dragged into order with Manage Queue; your own videos, or anyone's with Manage Queue,
// can be taken out). What you may do follows the channel's permissions; the server decides.
export default function WatchPartyPanel({ guild, channel, myId, onClose }) {
  useProfiles();
  const party = useWatchParty(guild.id, channel.id);
  const permissions = channel.my_permissions;
  const canQueue = has(permissions, PERMISSIONS.QUEUE_VIDEOS);
  const canManage = has(permissions, PERMISSIONS.MANAGE_QUEUE);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const queue = party?.queue ?? [];
  const ids = queue.map((item) => item.id);

  const { drag, itemProps } = useDragReorder(canManage ? ids : [], (next) => {
    const moved = movedItem(ids, next);
    if (!moved) return;
    setError(null);
    moveVideo(guild.id, channel.id, moved.id, moved.beforeId).catch((err) => setError(errorOf(err)));
  });

  const submit = async (e) => {
    e.preventDefault();
    const videoId = videoIdFromInput(link);
    if (!videoId) {
      setError(t('voice.watchParty.notAVideo'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addVideo(guild.id, channel.id, videoId);
      setLink('');
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (item) => {
    setError(null);
    removeVideo(guild.id, channel.id, item.id).catch((err) => setError(errorOf(err)));
  };

  const addedBy = (item) => t('voice.watchParty.addedBy', { name: displayName(item.added_by) });

  return (
    <section className="watch-party-panel" aria-label={t('voice.watchParty.title')}>
      <div className="watch-party-layout">
        {party?.current ? (
          <div className="watch-party-slot" ref={setPlayerSlot} />
        ) : (
          <div className="watch-party-empty">
            <FontAwesomeIcon icon={faClapperboard} size="2x" />
            <p>{canQueue ? t('voice.watchParty.emptyCanAdd') : t('voice.watchParty.emptyCantAdd')}</p>
          </div>
        )}
        <div className="watch-party-side">
          <div className="watch-party-side-header">
            <h2>{t('voice.watchParty.title')}</h2>
            {!party?.current && onClose && (
              <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.closePanel')} title={t('voice.watchParty.closePanel')} onClick={onClose}>
                <FontAwesomeIcon icon={faXmark} fixedWidth />
              </button>
            )}
          </div>
          {canQueue && (
            <form className="watch-party-add" onSubmit={submit}>
              <input
                type="text"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={t('voice.watchParty.linkPlaceholder')}
                aria-label={t('voice.watchParty.linkPlaceholder')}
                disabled={busy}
              />
              <button type="submit" className="watch-party-primary" disabled={busy || !link.trim()}>
                {party?.current ? t('voice.watchParty.addToQueue') : t('voice.watchParty.play')}
              </button>
            </form>
          )}
          {error && <p className="watch-party-error" role="alert">{error}</p>}
          {party?.current && (
            <div className="watch-party-now">
              <span className="watch-party-label">{t('voice.watchParty.nowPlaying')}</span>
              <span className="watch-party-item-title">{party.current.title ?? t('voice.watchParty.untitled')}</span>
              <span className="watch-party-item-meta">
                {[party.current.author, party.current.duration ? formatClock(party.current.duration) : null, addedBy(party.current)].filter(Boolean).join(' · ')}
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
                        {canManage && <FontAwesomeIcon icon={faGripVertical} className="watch-party-grip" aria-hidden="true" />}
                        <span className="watch-party-item-text">
                          <span className="watch-party-item-title">{item.title ?? t('voice.watchParty.untitled')}</span>
                          <span className="watch-party-item-meta">
                            {[item.duration ? formatClock(item.duration) : null, addedBy(item)].filter(Boolean).join(' · ')}
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
                            <FontAwesomeIcon icon={faXmark} fixedWidth />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
