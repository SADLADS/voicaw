import React from 'react';
import { Trans } from 'react-i18next';
import MessageEditor from '../editor/MessageEditor';
import EmojiSuggestions from './EmojiSuggestions';
import { useEmojiSuggestions } from '../hooks/useEmojiSuggestions';
import { t } from '../i18n';

// A message being edited in place (MessageList), with the message box's ":shortcode"
// suggestions above it (in the row, not floating: the list scrolls, so the top message's would
// be cut off). `editRef` is its MessageEditor's handle.
export default function InlineMessageEdit({
  messageId,
  editRef,
  initialText,
  mentionNames,
  mentionRoles,
  maxLength,
  submitOnEnter,
  s3Endpoint,
  onChange,
  onSave,
  onCancel,
}) {
  const emoji = useEmojiSuggestions(editRef, s3Endpoint);
  return (
    <div className="inline-edit-wrapper">
      {emoji.suggestions.length > 0 && (
        <EmojiSuggestions
          query={emoji.query}
          emojis={emoji.suggestions}
          activeIndex={emoji.activeIndex}
          onPick={emoji.pick}
          onHover={emoji.setActiveIndex}
          s3Endpoint={s3Endpoint}
        />
      )}
      <MessageEditor
        ref={editRef}
        id={`edit-input-${messageId}`}
        className="inline-edit-editor"
        ariaLabel={t('chat.message.editLabel')}
        initialText={initialText}
        mentionNames={mentionNames}
        mentionRoles={mentionRoles}
        maxLength={maxLength}
        submitOnEnter={submitOnEnter}
        onSubmit={onSave}
        onChange={(change) => {
          onChange(change.text);
          emoji.onChange(change);
        }}
        onKeyDown={(e) => {
          if (emoji.onKeyDown(e)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />

      <div className="inline-edit-banner">
        <span>
          <Trans
            i18nKey="chat.message.editHint"
            components={{
              cancel: <a href="#" onClick={(e) => { e.preventDefault(); onCancel(); }} />,
              save: <a href="#" onClick={(e) => { e.preventDefault(); onSave(); }} />,
            }}
          />
        </span>
      </div>
    </div>
  );
}
