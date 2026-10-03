import { useContext } from 'react';
import { NsfwChannelContext } from '../contexts';
import { usePreferences } from '../utils/preferences';
import { t } from '../i18n';

// What covers a piece of media until it's clicked (MediaCover): 'Spoiler' if its sender marked
// it as one, else 'NSFW' if it's in an NSFW channel (NsfwChannelContext) and Settings → Content
// hasn't turned that off, else null. A spoiler in an NSFW channel has just the one cover.
export function useMediaCover(spoiler = false) {
  const nsfw = useContext(NsfwChannelContext);
  const { blurNsfw } = usePreferences();
  if (spoiler) return t('media.cover.spoiler');
  return nsfw && blurNsfw ? t('media.cover.nsfw') : null;
}
