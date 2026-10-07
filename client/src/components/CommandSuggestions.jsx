import React, { useEffect, useRef } from 'react';
import { Trans } from 'react-i18next';
import Avatar from './Avatar';
import { displayName } from '../utils/profiles';
import { groupCommandsByBot } from '../utils/commandOptions';
import { t } from '../i18n';

// The "/" list above the message box in a guild channel (like EmojiSuggestions, styled the
// same): the channel's bot commands matching what's typed after "/" (`entries` from
// commandEntries/searchCommands, already in groupCommandsByBot's order, so arrow keys go down
// the list as drawn), one section per bot under its picture and name. It scrolls, keeping the
// active one in view. Mousedown picks one (so the box keeps focus).
export default function CommandSuggestions({ query, entries, activeIndex, onPick, onHover }) {
  const listRef = useRef(null);
  const sections = groupCommandsByBot(entries);

  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    // Inside the list only (scrollIntoView would also scroll the page around it).
    const list = listRef.current;
    if (!active || !list) return;
    const header = active.closest('.command-suggestion-section')?.querySelector('.command-suggestion-bot');
    const top = active.offsetTop - (header?.offsetHeight ?? 0);
    const bottom = active.offsetTop + active.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, query]);

  let index = 0;
  return (
    <div ref={listRef} className="emoji-suggestions command-suggestions" role="listbox" aria-label={t('commands.picker.label')}>
      <div className="emoji-suggestions-title">
        {query ? <Trans i18nKey="commands.picker.matching" values={{ query: `/${query}` }} components={{ b: <strong /> }} /> : t('commands.picker.title')}
      </div>
      {sections.map(({ bot, entries: own }) => {
        const name = displayName(bot?.id, bot?.name);
        return (
          <div key={bot?.id ?? ''} className="command-suggestion-section" role="group" aria-label={name}>
            <div className="command-suggestion-bot">
              <Avatar userId={bot?.id} className="command-suggestion-bot-avatar" />
              <span>{name}</span>
            </div>
            {own.map((entry) => {
              const i = index++;
              return (
                <div
                  key={entry.key}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`emoji-suggestion command-suggestion${i === activeIndex ? ' active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(entry);
                  }}
                  // Not mouseenter: that also fires when the list scrolls under a resting pointer.
                  onMouseMove={() => { if (i !== activeIndex) onHover(i); }}
                >
                  <span className="command-suggestion-text">
                    <span className="command-suggestion-name">/{entry.name}</span>
                    {entry.description && <span className="command-suggestion-description">{entry.description}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
