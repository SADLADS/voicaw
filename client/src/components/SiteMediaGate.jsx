import React, { useState } from 'react';
import { Icon } from './Icon';
import { faImage } from '@fortawesome/free-solid-svg-icons';
import { usePrivacyPrefs } from '../utils/privacy';
import { siteOf } from '../utils/linkPreviews';
import { t } from '../i18n';

// Pictures shown since the app was opened, so they stay loaded when the list redraws.
const shownPictures = new Set();

// Another site's picture (a link preview's, an embed's, a link straight to one), held back while
// Settings → Privacy's "Show link previews" is off (utils/privacy): a box saying which site it's
// from waits for a tap on Show, so that site learns nothing first. `style` sizes the box;
// `compact` makes it a small button instead (a card's thumbnail). Videos don't need this: with
// the setting off their player is given nothing to load before Play (MessageEmbeds).
export default function SiteMediaGate({ url, style, compact = false, children }) {
  const autoLoad = usePrivacyPrefs().linkPreviews;
  const [shown, setShown] = useState(() => shownPictures.has(url));
  if (autoLoad || shown) return children;
  const show = () => {
    shownPictures.add(url);
    setShown(true);
  };
  const label = t('media.links.pictureFrom', { site: siteOf(url) });
  if (compact) {
    return (
      <button type="button" className="embed-thumbnail link-media-show" onClick={show} aria-label={t('media.links.showPicture', { site: siteOf(url) })} title={label}>
        <Icon icon={faImage} />
      </button>
    );
  }
  return (
    <span className="attachment-gif-hidden" style={style}>
      <span>{label}</span>
      <button type="button" className="btn btn-secondary" onClick={show} aria-label={t('media.links.showPicture', { site: siteOf(url) })}>
        {t('media.attachment.show')}
      </button>
    </span>
  );
}
