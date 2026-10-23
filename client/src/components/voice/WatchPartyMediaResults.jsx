import React from 'react';
import { Icon } from '../Icon';
import { faCheck, faChevronLeft, faChevronRight, faXmark } from '@fortawesome/free-solid-svg-icons';
import { formatClock, mediaByline } from '../../voice/watchParty';
import { t } from '../../i18n';

// What a search of the guild's media server (Jellyfin or Emby) in WatchPartyPanel found:
// `search` is { query, series, results } (results null while searching; `series` { id, title }
// while a show's episodes are listed). Videos can be added (`onAdd`), as YouTube's results;
// a show opens to its episodes (`onOpenSeries`), with Back (`onBack`) to the search. Pictures
// load from the media server (the guild's own, which then sees your IP address).
const thumbClass = (item) => (item.type === 'Episode' || item.type === 'Video' ? '' : ' poster');

export default function WatchPartyMediaResults({ search, added, adding, playsNow, onAdd, onOpenSeries, onBack, onClose }) {
  const { query, series, results } = search;
  const heading = series ? series.title ?? t('voice.watchParty.media.show') : t('voice.watchParty.search.resultsFor', { query });
  return (
    <section className="watch-party-results" aria-label={heading} aria-busy={results === null}>
      <div className="watch-party-results-header">
        {series && (
          <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.media.back')} title={t('voice.watchParty.media.back')} onClick={onBack}>
            <Icon icon={faChevronLeft} fixedWidth />
          </button>
        )}
        <span className="watch-party-label">{heading}</span>
        <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.search.close')} title={t('voice.watchParty.search.close')} onClick={onClose}>
          <Icon icon={faXmark} fixedWidth />
        </button>
      </div>
      {results === null && <p className="watch-party-note">{t('voice.watchParty.media.searching')}</p>}
      {results?.length === 0 && <p className="watch-party-note">{series ? t('voice.watchParty.media.noEpisodes') : t('voice.watchParty.media.none')}</p>}
      {results?.length > 0 && (
        <ul className="watch-party-results-list">
          {results.map((item) => {
            const isShow = item.type === 'Series';
            const key = `media:${item.media_id}`;
            const isAdded = added.has(key);
            const title = item.title ?? t('voice.watchParty.untitled');
            // In a show's list, its name goes without saying.
            const byline = series && item.season != null && item.episode != null
              ? t('voice.watchParty.media.episodeNumber', { season: item.season, episode: item.episode })
              : mediaByline(item);
            const label = isShow
              ? t('voice.watchParty.media.episodesOf', { title })
              : isAdded
                ? t('voice.watchParty.search.addedLabel', { title })
                : t(playsNow ? 'voice.watchParty.search.playLabel' : 'voice.watchParty.search.addLabel', { title });
            return (
              <li key={item.media_id} className="watch-party-result">
                {/* Films' and shows' pictures are posters; episodes' are stills. */}
                {item.image_url
                  ? <img className={`watch-party-result-thumb${thumbClass(item)}`} src={item.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  : <span className={`watch-party-result-thumb${thumbClass(item)}`} aria-hidden="true" />}
                <span className="watch-party-item-text">
                  <span className="watch-party-result-title" title={title}>{title}</span>
                  <span className="watch-party-item-meta">
                    {[byline, item.duration ? formatClock(item.duration) : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {isShow ? (
                  <button type="button" className="watch-party-secondary" aria-label={label} onClick={() => onOpenSeries(item)}>
                    {t('voice.watchParty.media.episodes')} <Icon icon={faChevronRight} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={isAdded ? 'watch-party-secondary' : 'watch-party-primary'}
                    disabled={isAdded || adding != null}
                    aria-label={label}
                    onClick={() => onAdd(item)}
                  >
                    {isAdded ? <><Icon icon={faCheck} /> {t('voice.watchParty.search.added')}</> : t(playsNow ? 'voice.watchParty.play' : 'voice.watchParty.search.add')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
