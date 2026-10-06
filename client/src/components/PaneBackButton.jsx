import React, { useContext } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../contexts';
import { showList } from '../utils/mobilePanes';
import { t } from '../i18n';

// Phones: the arrow at the start of a chat's header, Discord style. It shows that the chat can
// be swiped away to the list underneath, and pressing it slides there the same way
// (hooks/useSwipePanes.js). Nothing on a computer, where both are on screen.
export default function PaneBackButton() {
  const { isMobile } = useContext(InteractionContext);
  if (!isMobile) return null;
  return (
    <button type="button" className="pane-back-button" aria-label={t('common.back')} title={t('common.back')} onClick={showList}>
      <FontAwesomeIcon icon={faArrowLeft} />
    </button>
  );
}
