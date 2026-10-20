import React, { useContext, useState } from 'react';
import { faBell, faBellSlash } from '@fortawesome/free-solid-svg-icons';
import ContextMenu from '../ContextMenu';
import { InteractionContext } from '../../contexts';
import { interestChoices } from '../../utils/eventDisplay';
import { t } from '../../i18n';

// Interested on an event (pressed: you are, in the occurrence shown). A toggle, or on a
// repeating event a menu: this event or all of them (utils/eventDisplay interestChoices).
// `onChoose({ interested, occurrence })`; `children` is its label.
export default function InterestButton({ event, className, onChoose, children }) {
  const { isMobile } = useContext(InteractionContext);
  const [anchor, setAnchor] = useState(null);
  const repeating = Boolean(event.recurrence);
  function onClick(e) {
    if (repeating) setAnchor(e.currentTarget.getBoundingClientRect());
    else onChoose({ interested: !event.interested, occurrence: false });
  }
  return (
    <>
      <button
        type="button"
        className={className}
        aria-pressed={Boolean(event.interested)}
        aria-haspopup={repeating ? 'menu' : undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {anchor && (
        <ContextMenu
          title={event.name}
          label={t('events.actions.interested')}
          items={interestChoices(event).map((choice) => ({
            key: choice.key,
            label: t(`events.interest.${choice.key}`),
            icon: choice.interested ? faBell : faBellSlash,
            onSelect: () => onChoose(choice),
          }))}
          anchor={anchor}
          sheet={isMobile}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
