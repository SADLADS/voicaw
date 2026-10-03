import React from 'react';
import { Trans } from 'react-i18next';
import Avatar from './Avatar';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';

// The "/" list above the message box in a guild channel (like EmojiSuggestions, styled the
// same): the channel's bot commands matching what's typed after "/" (`entries` from
// commandEntries/searchCommands), each with its bot's picture and name. Mousedown picks one
// (so the box keeps focus).
export default function CommandSuggestions({ query, entries, activeIndex, onPick, onHover }) {
  return (
    <div className="emoji-suggestions command-suggestions" role="listbox" aria-label={t('commands.picker.label')}>
      <div className="emoji-suggestions-title">
        {query ? <Trans i18nKey="commands.picker.matching" values={{ query: `/${query}` }} components={{ b: <strong /> }} /> : t('commands.picker.title')}
      </div>
      {entries.map((entry, i) => (
        <div
          key={entry.key}
          role="option"
          aria-selected={i === activeIndex}
          className={`emoji-suggestion command-suggestion${i === activeIndex ? ' active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(entry);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <Avatar userId={entry.command.bot?.id} className="mention-suggestion-avatar" />
          <span className="command-suggestion-text">
            <span className="command-suggestion-name">/{entry.name}</span>
            {entry.description && <span className="command-suggestion-description">{entry.description}</span>}
          </span>
          <span className="mention-suggestion-note">{displayName(entry.command.bot?.id, entry.command.bot?.name)}</span>
        </div>
      ))}
    </div>
  );
}
