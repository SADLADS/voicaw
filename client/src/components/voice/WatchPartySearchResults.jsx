import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatClock } from '../../voice/watchParty';
import { usePrivacyPrefs } from '../../utils/privacy';
import { t } from '../../i18n';

// What a YouTube search in WatchPartyPanel found: `search` is { query, results } (results null
// while searching). Each video can be added (`onAdd`); added ones say so, so several can be
// queued from one search; with nothing playing, the first one plays (`playsNow`). Thumbnails
// load from YouTube (which sees your IP address), so only when Settings → Privacy lets YouTube
// load at once.
export default function WatchPartySearchResults({ search, added, adding, playsNow, onAdd, onClose }) {
  const { youtubeEmbeds } = usePrivacyPrefs();
  const { query, results } = search;
  return (
    <section className="watch-party-results" aria-label={t('voice.watchParty.search.resultsFor', { query })} aria-busy={results === null}>
      <div className="watch-party-results-header">
        <span className="watch-party-label">{t('voice.watchParty.search.resultsFor', { query })}</span>
        <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.search.close')} title={t('voice.watchParty.search.close')} onClick={onClose}>
          <FontAwesomeIcon icon={faXmark} fixedWidth />
        </button>
      </div>
      {results === null && <p className="watch-party-note">{t('voice.watchParty.search.searching')}</p>}
      {results?.length === 0 && <p className="watch-party-note">{t('voice.watchParty.search.none')}</p>}
      {results?.length > 0 && (
        <ul className="watch-party-results-list">
          {results.map((video) => {
            const isAdded = added.has(video.video_id);
            const title = video.title ?? t('voice.watchParty.untitled');
            const label = isAdded
              ? t('voice.watchParty.search.addedLabel', { title })
              : t(playsNow ? 'voice.watchParty.search.playLabel' : 'voice.watchParty.search.addLabel', { title });
            return (
              <li key={video.video_id} className="watch-party-result">
                {youtubeEmbeds && (
                  <img
                    className="watch-party-result-thumb"
                    src={`https://i.ytimg.com/vi/${video.video_id}/mqdefault.jpg`}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                )}
                <span className="watch-party-item-text">
                  <span className="watch-party-result-title" title={title}>{title}</span>
                  <span className="watch-party-item-meta">
                    {[video.author, video.live ? t('voice.watchParty.search.live') : video.duration ? formatClock(video.duration) : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  className={isAdded ? 'watch-party-secondary' : 'watch-party-primary'}
                  disabled={isAdded || adding != null}
                  aria-label={label}
                  onClick={() => onAdd(video)}
                >
                  {isAdded ? <><FontAwesomeIcon icon={faCheck} /> {t('voice.watchParty.search.added')}</> : t(playsNow ? 'voice.watchParty.play' : 'voice.watchParty.search.add')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
